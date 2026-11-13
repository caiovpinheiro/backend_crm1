import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { downloadMediaMessage, getContentType } from "@whiskeysockets/baileys";
import crypto from "crypto";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { createMessageDedup } from "@/lib/message-dedup";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { fireTrigger, buildMessageTriggerData, emitConversationCreated, openingMessageTriggerExtra } from "@/services/automation-triggers";
import { ensureOpenDealForContact, findExistingContactOnPhone } from "@/services/auto-deals";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import {
  activeConversationOnAccountWhere,
  isActiveConversationUniqueViolation,
  withConversationNumberRetry,
} from "@/services/conversations";
import { maybeDistributeNewInboundTicket } from "@/services/distribution";
import { inheritContactAssigneeForNewTicket } from "@/services/ai/attendance-gate";
import { onInboundMessageForAi } from "@/services/ai/turn-manager";
import { resolvePostCloseInbound } from "@/services/post-close-return";
import { ensureInboundAiAttendance } from "@/services/ai-v2/first-attendance";
import { processIncomingMessage as processSalesbotMessage } from "@/services/automation-context";
import { notifyInboundMessage } from "@/lib/web-push";
import { cancelPendingForConversation } from "@/services/scheduled-messages";
import { touchInbound, warnTouchInboundFailed } from "@/lib/conversation-inbound";
import { getLogger } from "@/lib/logger";
import { maskPhone } from "@/lib/pii-mask";
import { safeFetchBytes } from "@/lib/safe-fetch";
import {
  publishContactUpdated,
  publishNewMessage,
} from "@/lib/realtime-events";
import { getOrgIdOrNull } from "@/lib/request-context";
import {
  formatSharedContactsText,
  parseBaileysSharedContacts,
  type SharedContact,
} from "@/lib/shared-contact";
import { isLidJid, resolveLidJid } from "./lid-resolver";
import { noteContactActivity } from "./contact-typing";
import {
  appendWhatsAppGroupMessage,
  applyGroupMessageReaction,
  findGroupMessageByWaId,
  findWhatsAppGroupByJid,
  groupQuoteAuthor,
  GROUP_MEDIA_TYPES,
  learnGroupMemberName,
} from "@/services/whatsapp-groups";
import { noteMessageRowChange } from "@/lib/cache/message-versions";

const log = getLogger("baileys-msg");

/** CDNs de onde o WhatsApp serve foto de perfil (`sock.profilePictureUrl`). */
const AVATAR_CDN_HOSTS = ["pps.whatsapp.net", "*.whatsapp.net", "*.fbcdn.net"];
const AVATAR_FETCH_TIMEOUT_MS = 15_000;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return `+${digits}`;
}

function jidToPhone(jid: string): string {
  const num = jid.split("@")[0].split(":")[0];
  return normalizePhone(num);
}

type CrmContact = {
  id: string;
  name: string;
  phone: string | null;
  avatarUrl: string | null;
  organizationId: string;
  /// Quando atualizamos foto de perfil pela ultima vez (atualizadoAt
  /// do contato e impreciso porque qualquer edicao manual zera o
  /// throttle). Persistido em `Contact.avatarUrl` mesmo — o `?v=`
  /// timestamp na URL marca a "geracao", facilitando comparacao
  /// rapida sem campo extra no schema.
};

async function resolveContact(
  jid: string,
  pushName: string | null | undefined,
  channelId: string,
): Promise<CrmContact> {
  const phone = jidToPhone(jid);

  const held = await findExistingContactOnPhone(phone);
  const existing = held
    ? await prisma.contact.findUnique({
        where: { id: held.contactId },
        select: { id: true, name: true, phone: true, avatarUrl: true, organizationId: true },
      })
    : null;

  if (existing) {
    const resolvedName = pushName && existing.name.startsWith("Lead +") ? pushName : existing.name;
    if (resolvedName !== existing.name) {
      prisma.contact.update({ where: { id: existing.id }, data: { name: resolvedName } }).catch(() => {});
    }

    // Contato JÁ EXISTE: só auto-cria deal se ele nunca tiver tido um
    // (raro — ex.: contato importado sem deal nenhum). Se tem histórico
    // (OPEN/WON/LOST), o controle passa pras automações configuradas
    // — não re-disparamos `deal_created` em lead descartado nem em
    // cliente que já comprou. Pra reativar lead LOST automaticamente,
    // criar automação `message_received` filtrada por dealStatus=LOST
    // com step `create_deal`. Ver `auto-deals.ts` (changelog v3).
    ensureOpenDealForContact({
      contactId: existing.id,
      contactName: resolvedName,
      source: "auto_whatsapp_qr",
      logTag: "baileys-msg",
      channelId,
    }).catch((err) =>
      log.warn("Falha ao garantir deal aberto:", err),
    );

    return { ...existing, name: resolvedName };
  }

  const name = pushName || `Lead ${phone}`;
  const contactSelect = {
    id: true,
    name: true,
    phone: true,
    avatarUrl: true,
    organizationId: true,
  } as const;
  let created: {
    id: string;
    name: string;
    phone: string | null;
    avatarUrl: string | null;
    organizationId: string;
  };
  try {
    created = await insertContactWithNextNumber(
      {
        name,
        phone,
        lifecycleStage: "LEAD" as const,
        source: "WhatsApp QR",
      },
      contactSelect,
    );
  } catch (err) {
    if (isPrismaUniqueViolation(err)) {
      const won = await prisma.contact.findFirst({
        where: { phone },
        select: contactSelect,
      });
      if (won) return won;
    }
    throw err;
  }

  // Dispara automações com trigger "contact_created" antes do auto-deal,
  // mantendo a ordem semântica (contato → deal). Fire-and-forget para
  // nao atrasar o processamento de mensagens do Baileys.
  fireTrigger("contact_created", {
    contactId: created.id,
    data: { source: "WhatsApp QR", channel: "WhatsApp" },
  }).catch((err) => log.warn("Falha no gatilho contact_created:", err));

  ensureOpenDealForContact({
    contactId: created.id,
    contactName: name,
    source: "auto_whatsapp_qr",
    logTag: "baileys-msg",
    channelId,
  }).catch((err) => log.warn("Falha ao garantir deal aberto:", err));

  // SEC2-5: sem nome/telefone em claro — ID do contato + telefone mascarado.
  log.info({ contactId: created.id, phone: maskPhone(phone) }, "Novo lead criado via WhatsApp (QR)");
  return created;
}

// ─────────────────────────────────────────────────────────────────
// Profile picture sync (Baileys)
// ─────────────────────────────────────────────────────────────────
//
// Diferente da Meta WhatsApp Business API oficial — que NAO expoe
// foto de perfil de contatos por privacidade — o Baileys (Web Multi
// Device) acessa a foto via `sock.profilePictureUrl(jid, "image")`.
// Retorna URL HTTPS temporaria do CDN do WhatsApp (~24h) ou
// joga 401/404 se o contato:
//   - tem foto privada (configuracao Privacidade > Foto > Meus
//     contatos), OU
//   - bloqueou o numero conectado, OU
//   - simplesmente nao tem foto.
//
// Estrategia:
//   1. Throttle agressivo via `?v=YYYYMMDD` no avatarUrl — so
//      refrescamos UMA vez por dia por contato (chamadas demais ao
//      profilePictureUrl podem disparar throttling do WA).
//   2. Baixamos a imagem e SALVAMOS LOCAL em /uploads/avatars/{id}.jpg.
//      A URL CDN da Meta expira; servir da nossa origem evita 403
//      depois e funciona offline com o SW do PWA.
//   3. Falha silenciosa: se nao deu, log warn e segue. Nunca
//      bloqueia o processamento da mensagem.

const AVATAR_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 dia

/**
 * Devolve `true` se a `avatarUrl` atual ja tem uma versao recente
 * (decodificando o `?v=` epoch ms que cravamos quando salvamos).
 * Sem `?v=` ou parse falhou → considera stale.
 */
function isAvatarFresh(avatarUrl: string | null): boolean {
  if (!avatarUrl) return false;
  const idx = avatarUrl.indexOf("?v=");
  if (idx < 0) return false;
  const ts = Number(avatarUrl.slice(idx + 3));
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < AVATAR_REFRESH_INTERVAL_MS;
}

async function syncContactAvatar(
  contact: CrmContact,
  jid: string,
  sock: WASocket,
): Promise<void> {
  if (isAvatarFresh(contact.avatarUrl)) return;

  let cdnUrl: string | undefined;
  try {
    cdnUrl = await sock.profilePictureUrl(jid, "image");
  } catch (err) {
    // 401/404 = privada/sem foto/bloqueado — esperado, nao loga.
    const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
    if (code !== 401 && code !== 404) {
      log.debug(
        `Falha ao obter foto de perfil (HTTP ${code ?? "?"}) para ${jid}:`,
        (err as Error).message,
      );
    }
    return;
  }
  if (!cdnUrl) return;

  try {
    // URL vem do servidor do WhatsApp: restringe aos CDNs conhecidos, sem
    // redirect, com timeout e limite de bytes (anti-SSRF / anti-abuso).
    const { response: res, buffer } = await safeFetchBytes(
      cdnUrl,
      {},
      {
        allowedHosts: AVATAR_CDN_HOSTS,
        maxRedirects: 0,
        timeoutMs: AVATAR_FETCH_TIMEOUT_MS,
        maxBytes: AVATAR_MAX_BYTES,
      },
    );
    if (!res.ok) {
      log.debug(`Falha ao baixar avatar (HTTP ${res.status}) para ${jid}`);
      return;
    }
    if (buffer.length === 0) return;

    // PR 1.3: storage tenant-scoped. Antes: shared `public/uploads/avatars/`.
    const filename = `${contact.id}.jpg`;
    const saved = await saveFile({
      orgId: contact.organizationId,
      bucket: "avatars",
      fileName: filename,
      buffer,
    });
    const newUrl = `${saved.url}?v=${Date.now()}`;

    await prisma.contact.update({
      where: { id: contact.id },
      data: { avatarUrl: newUrl },
    });

    // Notifica a UI: lista de conversas, header, deal panel — tudo
    // que renderiza ChatAvatar pra esse contato deve refetchar.
    publishContactUpdated({
      organizationId: contact.organizationId,
      contactId: contact.id,
      avatarUrl: newUrl,
    });

    log.debug(`Avatar atualizado: ${contact.name} (${contact.id})`);
  } catch (err) {
    log.debug(`Erro ao salvar avatar de ${jid}:`, (err as Error).message);
  }
}

// A lógica de auto-criação de deal está em `src/services/auto-deals.ts`
// (`ensureOpenDealForContact`). Desde v3 (jun/2026) o helper só
// auto-cria deal pra contato SEM histórico de deals; contatos com
// OPEN/WON/LOST passam pelo helper mas viram no-op — a reativação fica
// a cargo das automações configuradas pelo operador (trigger
// `message_received` + filtro `dealStatus`).

const CONV_SELECT = {
  id: true,
  status: true,
  channelId: true,
  waJid: true,
  assignedToId: true,
} as const;

async function findActiveConversation(contactId: string, channelId: string | null) {
  return prisma.conversation.findFirst({
    where: activeConversationOnAccountWhere({
      contactId,
      channel: "whatsapp",
      channelId,
    }),
    select: CONV_SELECT,
  });
}

async function findOrCreateConversation(
  contactId: string,
  channelId: string,
  rawJid: string,
  opening?: { content?: string | null; messageType?: string | null },
) {
  // Ticket = contato + WhatsApp + conta Baileys. Nao reusa OPEN de outra
  // conexao e nao sobrescreve o channelId dela.
  const existing = await findActiveConversation(contactId, channelId);

  if (existing) {
    if (existing.waJid !== rawJid) {
      await prisma.conversation.update({
        where: { id: existing.id },
        data: { waJid: rawJid },
      });
    }
    await maybeDistributeNewInboundTicket({
      conversationId: existing.id,
      contactId,
      assignedToId: existing.assignedToId ?? null,
    });
    return existing;
  }

  const orphan = await findActiveConversation(contactId, null);
  if (orphan) {
    const updates: Record<string, unknown> = { channelId };
    if (orphan.waJid !== rawJid) updates.waJid = rawJid;
    await prisma.conversation.update({ where: { id: orphan.id }, data: updates });
    await maybeDistributeNewInboundTicket({
      conversationId: orphan.id,
      contactId,
      assignedToId: orphan.assignedToId ?? null,
    });
    return { ...orphan, channelId, waJid: rawJid };
  }

  // Logo depois de um encerramento: cortesia fica na conversa encerrada
  // (sem ticket, sem IA); conteúdo após atendimento de pessoa não herda o
  // agente de IA do contato.
  const postClose = await resolvePostCloseInbound({
    contactId,
    channel: "whatsapp",
    channelId,
    text: opening?.content,
    messageType: opening?.messageType,
  });
  if (postClose?.kind === "courtesy") {
    const closed = await prisma.conversation.findUnique({ where: { id: postClose.conversation.id }, select: CONV_SELECT });
    if (closed) return { ...closed, postCloseCourtesy: true as const };
  }
  const returnToHuman = postClose?.kind === "return_to_human";
  const inheritAssignee = returnToHuman ? null : await inheritContactAssigneeForNewTicket(contactId);

  try {
    const created = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          contactId,
          channel: "whatsapp",
          channelId,
          waJid: rawJid,
          status: "OPEN" as const,
          ...(inheritAssignee ? { assignedToId: inheritAssignee } : {}),
        }),
        select: CONV_SELECT,
      }),
    );
    await maybeDistributeNewInboundTicket({
      conversationId: created.id,
      contactId,
      assignedToId: inheritAssignee,
      // Voltou de atendimento de pessoa: a fila humana, não a IA.
      skipAiFirstAttendance: returnToHuman,
    });
    emitConversationCreated({
      contactId,
      channel: "whatsapp",
      channelId,
      conversationId: created.id,
      source: "inbound_baileys",
      extra: openingMessageTriggerExtra({
        content: opening?.content,
        messageType: opening?.messageType,
      }),
    });
    return { ...created, returnToHuman };
  } catch (err) {
    // Corrida no mesmo número: o indice unico parcial rejeita o 2o
    // create com P2002. Reusa o vencedor desta conta.
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findActiveConversation(contactId, channelId);
      if (won) return won;
    }
    throw err;
  }
}

type ParsedMsg = {
  text: string;
  messageType: string;
  mediaUrl: string | null;
  externalId: string;
  sharedContacts?: SharedContact[] | null;
};

type AnyMsg = Record<string, any>;

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/ogg; codecs=opus": "ogg", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/plain": "txt", "text/csv": "csv",
  "application/zip": "zip", "application/x-rar-compressed": "rar",
};

function resolveExtension(type: string, mimetype?: string, fileName?: string): string {
  if (fileName) {
    const parts = fileName.split(".");
    if (parts.length > 1) return parts.pop()!.toLowerCase();
  }
  if (mimetype) {
    const found = MIME_TO_EXT[mimetype.split(";")[0].trim()];
    if (found) return found;
  }
  const fallback: Record<string, string> = {
    image: "jpg", video: "mp4", audio: "ogg", sticker: "webp", document: "bin", ptt: "ogg",
  };
  return fallback[type] ?? "bin";
}

function unwrapViewOnce(msgContent: AnyMsg): { inner: AnyMsg; isViewOnce: boolean } {
  if (msgContent.viewOnceMessage?.message) {
    return { inner: msgContent.viewOnceMessage.message, isViewOnce: true };
  }
  if (msgContent.viewOnceMessageV2?.message) {
    return { inner: msgContent.viewOnceMessageV2.message, isViewOnce: true };
  }
  if (msgContent.viewOnceMessageV2Extension?.message) {
    return { inner: msgContent.viewOnceMessageV2Extension.message, isViewOnce: true };
  }
  return { inner: msgContent, isViewOnce: false };
}

async function parseMessage(
  msg: WAMessage,
  sock: WASocket,
  organizationId: string,
): Promise<ParsedMsg | null> {
  const rawContent = msg.message;
  if (!rawContent) return null;

  let contentType = getContentType(rawContent);
  if (!contentType) return null;

  const externalId = msg.key.id ?? crypto.randomUUID();

  const { inner, isViewOnce } = unwrapViewOnce(rawContent as AnyMsg);
  if (isViewOnce) {
    contentType = getContentType(inner) ?? contentType;
  }
  const msgContent = isViewOnce ? inner : rawContent;

  if (contentType === "conversation" || contentType === "extendedTextMessage") {
    const text =
      (msgContent as AnyMsg).conversation ??
      (msgContent as AnyMsg).extendedTextMessage?.text ??
      "";
    return { text, messageType: "text", mediaUrl: null, externalId };
  }

  const mediaTypes: Record<string, string> = {
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    documentMessage: "document",
    stickerMessage: "sticker",
  };

  if (contentType in mediaTypes) {
    const mediaNode = (msgContent as AnyMsg)[contentType] ?? {};
    const caption: string = mediaNode.caption ?? "";
    const mimetype: string | undefined = mediaNode.mimetype;
    const fileName: string | undefined = mediaNode.fileName;
    const isPtt: boolean = !!mediaNode.ptt;

    let crmType = mediaTypes[contentType];
    if (crmType === "audio" && isPtt) crmType = "ptt";

    const ext = resolveExtension(crmType, mimetype, fileName);
    const mediaUrl = await downloadAndSave(
      msg,
      sock,
      ext,
      organizationId,
      isViewOnce ? inner : undefined,
    );

    const viewOnceLabel = isViewOnce ? " 👁" : "";
    let displayText: string;
    if (caption) {
      displayText = caption + viewOnceLabel;
    } else if (crmType === "document" && fileName) {
      displayText = `📎 ${fileName}${viewOnceLabel}`;
    } else if (isViewOnce) {
      displayText = `[${crmType}] 👁`;
    } else {
      displayText = `[${crmType}]`;
    }

    return {
      text: displayText,
      messageType: crmType,
      mediaUrl,
      externalId,
    };
  }

  if (contentType === "contactMessage" || contentType === "contactsArrayMessage") {
    const node =
      contentType === "contactsArrayMessage"
        ? (msgContent as AnyMsg).contactsArrayMessage
        : (msgContent as AnyMsg).contactMessage;
    const sharedContacts = parseBaileysSharedContacts(node);
    return {
      text: formatSharedContactsText(sharedContacts),
      messageType: "contact",
      mediaUrl: null,
      externalId,
      sharedContacts,
    };
  }

  if (contentType === "locationMessage" || contentType === "liveLocationMessage") {
    const loc = (msgContent as AnyMsg).locationMessage ?? (msgContent as AnyMsg).liveLocationMessage;
    const lat = loc?.degreesLatitude ?? 0;
    const lng = loc?.degreesLongitude ?? 0;
    return {
      text: `📍 Localização: ${lat}, ${lng}`,
      messageType: "location",
      mediaUrl: null,
      externalId,
    };
  }

  const ignoredTypes = new Set([
    "reactionMessage",
    "protocolMessage",
    "senderKeyDistributionMessage",
    "messageContextInfo",
    "ephemeralMessage",
    "editedMessage",
    "peerDataOperationRequestMessage",
    "peerDataOperationRequestResponseMessage",
    "encReactionMessage",
    "keepInChatMessage",
    "pollUpdateMessage",
  ]);

  if (ignoredTypes.has(contentType)) {
    return null;
  }

  return { text: `[${contentType}]`, messageType: "text", mediaUrl: null, externalId };
}

async function downloadAndSave(
  msg: WAMessage,
  sock: WASocket,
  ext: string,
  organizationId: string,
  viewOnceInner?: AnyMsg,
): Promise<string | null> {
  try {
    const downloadTarget = viewOnceInner
      ? { ...msg, message: viewOnceInner } as WAMessage
      : msg;
    const buffer = await downloadMediaMessage(downloadTarget, "buffer", {});
    if (!buffer) return null;

    // PR 1.3: storage tenant-scoped. Antes: shared `public/uploads/`.
    const filename = generateFileName({ prefix: "wa", ext });
    const saved = await saveFile({
      orgId: organizationId,
      bucket: "inbound-media",
      fileName: filename,
      buffer: buffer as Buffer,
    });
    return saved.url;
  } catch (e) {
    log.warn("Falha ao baixar mídia do WhatsApp:", e);
    return null;
  }
}

function groupMessagePreview(msg: WAMessage): string | null {
  const raw = msg.message;
  if (!raw) return null;
  const type = getContentType(raw);
  if (!type) return null;
  const node = (raw as Record<string, { text?: string; caption?: string; conversation?: string; fileName?: string }>)[type];
  if (type === "conversation") return raw.conversation?.trim() || null;
  if (type === "extendedTextMessage") return raw.extendedTextMessage?.text?.trim() || null;
  if (node?.caption?.trim()) return node.caption.trim();
  if (type === "imageMessage") return "[imagem]";
  if (type === "videoMessage") return "[vídeo]";
  if (type === "audioMessage" || type === "ptt") return "[áudio]";
  if (type === "documentMessage") return node?.fileName ? `📎 ${node.fileName}` : "[arquivo]";
  if (type === "stickerMessage") return "[sticker]";
  if (type === "contactMessage" || type === "contactsArrayMessage") return "[contato]";
  if (type === "locationMessage" || type === "liveLocationMessage") return "[localização]";
  return null;
}

/** Tipo/nome do arquivo de uma mídia recebida em grupo (o que o balão precisa). */
export function groupMediaMeta(msg: WAMessage): { mimeType: string | null; fileName: string | null } {
  const raw = msg.message;
  if (!raw) return { mimeType: null, fileName: null };
  const { inner, isViewOnce } = unwrapViewOnce(raw as AnyMsg);
  const content = isViewOnce ? inner : (raw as AnyMsg);
  const type = getContentType(content as WAMessage["message"] & object);
  const node = type ? (content as AnyMsg)[type] : null;
  const mimeType = typeof node?.mimetype === "string" ? node.mimetype.split(";")[0].trim() || null : null;
  const fileName = typeof node?.fileName === "string" && node.fileName.trim() ? node.fileName.trim() : null;
  return { mimeType, fileName };
}

/** Citação de uma mensagem do grupo (resposta): id, trecho e participante. */
export function groupQuoteRef(
  msg: WAMessage,
): { waId: string; text: string; participant: string | null } | null {
  const raw = msg.message as AnyMsg | null | undefined;
  if (!raw) return null;
  const type = getContentType(raw as WAMessage["message"] & object);
  const ctx = type ? (raw as AnyMsg)[type]?.contextInfo : null;
  if (!ctx?.stanzaId) return null;
  const q = (ctx.quotedMessage ?? {}) as AnyMsg;
  const qType = getContentType(q as WAMessage["message"] & object);
  const node = qType ? q[qType] : null;
  const labels: Record<string, string> = {
    imageMessage: "📷 Foto",
    videoMessage: "🎥 Vídeo",
    audioMessage: "🎤 Áudio",
    stickerMessage: "Figurinha",
  };
  const text =
    q.conversation ||
    q.extendedTextMessage?.text ||
    node?.caption ||
    (qType === "documentMessage" ? `📎 ${node?.fileName ?? "Arquivo"}` : null) ||
    (qType ? labels[qType] : null) ||
    "";
  return { waId: String(ctx.stanzaId), text: String(text), participant: ctx.participant ?? null };
}

async function groupQuoteFor(
  groupId: string,
  msg: WAMessage,
): Promise<{ waId: string; text: string; author: string | null } | null> {
  const ref = groupQuoteRef(msg);
  if (!ref) return null;
  // Autor: pela mensagem gravada no CRM; senão pelo telefone de quem foi citado.
  const original = await findGroupMessageByWaId(groupId, ref.waId).catch(() => null);
  const author = original
    ? groupQuoteAuthor(original)
    : ref.participant?.endsWith("@s.whatsapp.net")
      ? jidToPhone(ref.participant)
      : null;
  return { waId: ref.waId, text: ref.text || original?.text || "", author };
}

async function persistIncomingGroupMessage(
  channelId: string,
  groupJid: string,
  msg: WAMessage,
  sock: WASocket,
): Promise<void> {
  // Reação de alguém do grupo (ou do próprio número pelo celular).
  const reaction = msg.message?.reactionMessage;
  if (reaction?.key?.id) {
    const group = await findWhatsAppGroupByJid(channelId, groupJid);
    if (!group) return;
    const target = await findGroupMessageByWaId(group.id, reaction.key.id);
    if (!target) return;
    await applyGroupMessageReaction(target.id, target.reactions, {
      from: msg.key.fromMe ? "me" : msg.key.participant || groupJid,
      emoji: reaction.text ?? "",
      name: msg.key.fromMe ? null : msg.pushName ?? null,
    });
    return;
  }

  const preview = groupMessagePreview(msg);
  if (!preview) return;
  const group = await findWhatsAppGroupByJid(channelId, groupJid);
  if (!group) return;

  const key = msg.key as WAMessage["key"] & { participantAlt?: string | null };
  const fromJid = key.participant || groupJid;
  const phoneJid = [fromJid, key.participantAlt].find(
    (j): j is string => Boolean(j && (j.endsWith("@s.whatsapp.net") || j.endsWith("@c.us"))),
  );
  const phone = phoneJid ? jidToPhone(phoneJid) : null;

  // Mídia: baixa e guarda como o inbox (o balão só carrega ao tocar).
  let text = preview;
  let messageType = "text";
  let mediaUrl: string | null = null;
  let meta: { mimeType: string | null; fileName: string | null } = { mimeType: null, fileName: null };
  const parsed = await parseMessage(msg, sock, group.organizationId).catch((err) => {
    log.warn({ channelId, groupJid, err }, "[baileys] mídia do grupo não processada");
    return null;
  });
  if (parsed && GROUP_MEDIA_TYPES.has(parsed.messageType)) {
    text = parsed.text || preview;
    messageType = parsed.messageType;
    mediaUrl = parsed.mediaUrl;
    meta = groupMediaMeta(msg);
  }

  await appendWhatsAppGroupMessage({
    organizationId: group.organizationId,
    groupId: group.id,
    waMessageId: msg.key.id ?? null,
    fromJid,
    fromName: msg.pushName ?? null,
    fromPhone: phone,
    fromMe: Boolean(msg.key.fromMe),
    text,
    messageType,
    mediaUrl,
    mimeType: meta.mimeType,
    fileName: meta.fileName,
    replyTo: await groupQuoteFor(group.id, msg),
  });

  // Nome do perfil do WhatsApp no participante (como o nome dos candidatos).
  if (!msg.key.fromMe && msg.pushName?.trim()) {
    await learnGroupMemberName({
      groupId: group.id,
      jids: [key.participant, key.participantAlt],
      // Participante sincronizado guarda o telefone só com dígitos.
      phone: phone ? phone.replace(/\D/g, "") : null,
      name: msg.pushName,
    }).catch((err) =>
      log.warn({ channelId, groupJid, err }, "[baileys] nome do participante não gravado"),
    );
  }
}

export async function handleBaileysMessage(
  channelId: string,
  msg: WAMessage,
  sock: WASocket,
): Promise<void> {
  try {
    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid === "status@broadcast") return;
    if (rawJid.endsWith("@g.us")) {
      await persistIncomingGroupMessage(channelId, rawJid, msg, sock);
      return;
    }

    let jid = rawJid;
    if (isLidJid(rawJid)) {
      // Contato fora da agenda sincronizada não tem par no mapa: usa o
      // telefone que o WhatsApp manda junto (`remoteJidAlt`) ou o mapa LID
      // da sessão. Antes caía direto no LID e criava contato "+<lid>".
      const resolved = await resolveLidJid(channelId, rawJid, {
        alt: msg.key.remoteJidAlt,
        lookup: (lid) =>
          sock.signalRepository?.lidMapping?.getPNForLID(lid) ?? Promise.resolve(null),
      });
      if (resolved) {
        jid = resolved;
      } else {
        log.debug(
          `LID não resolvido (${rawJid.split("@")[0]}) — usando como fallback até contacts sincronizar`,
        );
      }
    }

    // PR 1.3: precisamos do organizationId ANTES de parsear, pois
    // mídia inbound é gravada em storage tenant-scoped.
    const channelOwner = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { organizationId: true },
    });
    if (!channelOwner) {
      log.warn(`Channel ${channelId} não encontrado, descartando mensagem.`);
      return;
    }

    const parsed = await parseMessage(msg, sock, channelOwner.organizationId);
    if (!parsed) return;

    const existingMsg = await prisma.message.findFirst({
      where: { externalId: parsed.externalId },
      select: { id: true },
    });
    if (existingMsg) return;

    const contact = await resolveContact(jid, msg.pushName, channelId);
    const conversation = await findOrCreateConversation(contact.id, channelId, rawJid, {
      content: parsed.text,
      messageType: parsed.messageType,
    });

    // Sincronizar foto de perfil em background — nao bloqueia o
    // processamento da mensagem (essencial pra throughput).
    syncContactAvatar(contact, jid, sock).catch((err) =>
      log.debug("Falha ao sincronizar avatar (não-fatal):", err),
    );

    // `createMessageDedup` fora da transação: o P2002 aborta a tx no
    // Postgres, então engolir dentro do callback deixaria o COMMIT em
    // estado inválido. Aqui a tx faz rollback e a duplicata volta `null`.
    const msgCreated = await createMessageDedup(() =>
      prisma.$transaction(async (tx) => {
        const dup = await tx.message.findFirst({
          where: { externalId: parsed.externalId },
          select: { id: true },
        });
        if (dup) return null;

        return tx.message.create({
          data: withOrgFromCtx({
            conversationId: conversation.id,
            channelId,
            content: parsed.text,
            direction: "in",
            messageType: parsed.messageType,
            externalId: parsed.externalId,
            senderName: msg.pushName ?? contact.name,
            mediaUrl: parsed.mediaUrl,
            ...(parsed.sharedContacts?.length
              ? { sharedContacts: parsed.sharedContacts }
              : {}),
          }),
        });
      }),
    );

    if (!msgCreated) return;
    // Fora da transação (já commitada): a versão sobe com a linha visível.
    void noteMessageRowChange(msgCreated, "new");

    // "digitando…" do contato: mensagem nova numa conversa aberta assina
    // (ou renova) a presença deste JID. Só memória + 1 nó no socket; a
    // política (TTL, teto, ritmo) está em `contact-typing.ts`.
    noteContactActivity(channelId, {
      jid: rawJid,
      resolvedJid: jid,
      organizationId: channelOwner.organizationId,
      conversationId: conversation.id,
      contactId: contact.id,
      conversationStatus: conversation.status,
    });

    const inboundAt = new Date();
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessageDirection: "in",
        hasAgentReply: false,
        hasError: false,
        updatedAt: new Date(),
      },
    }).catch(() => {});
    await touchInbound({ conversationId: conversation.id, at: inboundAt }).catch((err) =>
      warnTouchInboundFailed(err, {
        conversationId: conversation.id,
        channel: "whatsapp",
      }),
    );

    // Cliente respondeu: cancela qualquer mensagem agendada pendente.
    cancelPendingForConversation(conversation.id, "client_reply").catch(
      (err) => log.warn("Falha ao cancelar agendamentos pendentes:", err),
    );

    publishNewMessage({
      organizationId: getOrgIdOrNull(),
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "in",
      assignedToId: conversation.assignedToId ?? null,
      content: parsed.text,
      timestamp: new Date().toISOString(),
      ...(parsed.messageType === "contact"
        ? {
            messageType: "contact",
            ...(parsed.sharedContacts?.length
              ? { sharedContacts: parsed.sharedContacts }
              : {}),
          }
        : {}),
    });

    // Cortesia logo após o encerramento: registrada, e só. Sem push,
    // sem fluxo, sem gatilho, sem IA — o atendimento acabou.
    if ("postCloseCourtesy" in conversation && conversation.postCloseCourtesy) {
      log.info(
        { event: "skip_ai_inbound", conversationId: conversation.id, messageId: msgCreated.id, reason: "post_close_courtesy", messageType: parsed.messageType },
        "[ai-turn] skip_ai_inbound",
      );
      return;
    }

    notifyInboundMessage({
      conversationId: conversation.id,
      contactId: contact.id,
      contactName: contact.name,
      preview: parsed.text || "[mídia]",
      channel: "WhatsApp",
    }).catch((err) => log.debug("Falha ao enviar push (não-fatal):", err));

    try {
      // Voltou de um atendimento de pessoa: a equipe atende, não a IA.
      if (!("returnToHuman" in conversation && conversation.returnToHuman)) {
        await ensureInboundAiAttendance({
          conversationId: conversation.id,
          contactId: contact.id,
        });
      }
    } catch (err) {
      log.error("Falha no ensureInboundAiAttendance:", err);
    }

    try {
      await processSalesbotMessage(contact.id, parsed.text, {
        channelId,
        conversationId: conversation.id,
        messageType: parsed.messageType,
      });
    } catch (err) {
      log.error("Falha no salesbot:", err);
    }

    try {
      await fireTrigger("message_received", {
        contactId: contact.id,
        data: buildMessageTriggerData({
          channel: "WhatsApp",
          channelId,
          conversationId: conversation.id,
          content: parsed.text,
          extra: { waMessageId: parsed.externalId },
        }),
      });
    } catch (err) {
      log.error("Falha ao disparar gatilho message_received:", err);
    }

    if (parsed.text) {
      void onInboundMessageForAi({
        conversationId: conversation.id,
        contactId: contact.id,
        messageId: msgCreated.id,
        userMessage: parsed.text,
        channel: "baileys",
      });
    }

    log.info(`Mensagem de ${contact.name}: ${parsed.text.substring(0, 60)}`);
  } catch (err) {
    log.error("Erro ao processar mensagem:", err);
  }
}
