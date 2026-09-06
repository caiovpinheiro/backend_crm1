import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { downloadMediaMessage, getContentType } from "@whiskeysockets/baileys";
import crypto from "crypto";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { createMessageDedup } from "@/lib/message-dedup";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { ensureOpenDealForContact } from "@/services/auto-deals";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import {
  isActiveConversationUniqueViolation,
  withConversationNumberRetry,
} from "@/services/conversations";
import { maybeDistributeNewInboundTicket } from "@/services/distribution";
import { scheduleAiReply } from "@/services/ai/inbound-debounce";
import { ensureInboundAiAttendance } from "@/services/ai/first-attendance";
import { processIncomingMessage as processSalesbotMessage } from "@/services/automation-context";
import { notifyInboundMessage } from "@/lib/web-push";
import { cancelPendingForConversation } from "@/services/scheduled-messages";
import { touchInbound, warnTouchInboundFailed } from "@/lib/conversation-inbound";
import { getLogger } from "@/lib/logger";
import { sseBus } from "@/lib/sse-bus";
import { getOrgIdOrNull } from "@/lib/request-context";
import { isLidJid, resolveJid } from "./lid-resolver";

const log = getLogger("baileys-msg");

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

  const existing = await prisma.contact.findFirst({
    where: { phone },
    select: { id: true, name: true, phone: true, avatarUrl: true, organizationId: true },
  });

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

  log.info(`Novo lead: ${name} (${phone})`);
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
    const res = await fetch(cdnUrl);
    if (!res.ok) {
      log.debug(`Falha ao baixar avatar (HTTP ${res.status}) para ${jid}`);
      return;
    }
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) return;

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
    sseBus.publish("contact_updated", {
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

async function findActiveConversation(contactId: string) {
  return prisma.conversation.findFirst({
    where: { contactId, channel: "whatsapp", status: { not: "RESOLVED" } },
    select: CONV_SELECT,
  });
}

async function findOrCreateConversation(contactId: string, channelId: string, rawJid: string) {
  // Modelo de ticket: nova mensagem em contato com ultima RESOLVED cria
  // conversa nova (com #N+1). Ver AGENT.md "ID de conversa + ticket".
  const existing = await findActiveConversation(contactId);

  if (existing) {
    // Reusa conversa ativa (nao-RESOLVED por construcao); so reconcilia
    // metadados de canal/jid. Nao promove pra OPEN aqui — o modelo de
    // ticket ja garante que existing esta em OPEN/PENDING/SNOOZED.
    const updates: Record<string, unknown> = {};
    if (existing.channelId !== channelId) updates.channelId = channelId;
    if (existing.waJid !== rawJid) updates.waJid = rawJid;
    if (Object.keys(updates).length > 0) {
      await prisma.conversation.update({ where: { id: existing.id }, data: updates });
    }
    return existing;
  }

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { assignedToId: true },
  });

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
          ...(contact?.assignedToId ? { assignedToId: contact.assignedToId } : {}),
        }),
        select: CONV_SELECT,
      }),
    );
    await maybeDistributeNewInboundTicket({
      conversationId: created.id,
      contactId,
      assignedToId: contact?.assignedToId ?? null,
    });
    return created;
  } catch (err) {
    // Corrida: mensagens simultaneas do mesmo numero disparam dois
    // findOrCreate; o indice unico parcial (1 conversa ativa por
    // contato+canal) rejeita o 2o create com P2002. Reusa o vencedor em
    // vez de duplicar o ticket. Ver migration
    // `conversations_active_contact_channel`.
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findActiveConversation(contactId);
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
    const displayName =
      (msgContent as AnyMsg).contactMessage?.displayName ??
      (msgContent as AnyMsg).contactsArrayMessage?.displayName ??
      "Contato";
    return { text: `[contato] ${displayName}`, messageType: "text", mediaUrl: null, externalId };
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

export async function handleBaileysMessage(
  channelId: string,
  msg: WAMessage,
  sock: WASocket,
): Promise<void> {
  try {
    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid === "status@broadcast" || rawJid.endsWith("@g.us")) return;

    let jid = rawJid;
    if (isLidJid(rawJid)) {
      const resolved = resolveJid(channelId, rawJid);
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
    const conversation = await findOrCreateConversation(contact.id, channelId, rawJid);

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
          }),
        });
      }),
    );

    if (!msgCreated) return;

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
        channel: conversation.channel ?? "whatsapp",
      }),
    );

    // Cliente respondeu: cancela qualquer mensagem agendada pendente.
    cancelPendingForConversation(conversation.id, "client_reply").catch(
      (err) => log.warn("Falha ao cancelar agendamentos pendentes:", err),
    );

    sseBus.publish("new_message", {
      organizationId: getOrgIdOrNull(),
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "in",
      assignedToId: conversation.assignedToId ?? null,
      content: parsed.text,
      timestamp: new Date().toISOString(),
    });

    notifyInboundMessage({
      conversationId: conversation.id,
      contactId: contact.id,
      contactName: contact.name,
      preview: parsed.text || "[mídia]",
      channel: "WhatsApp",
    }).catch((err) => log.debug("Falha ao enviar push (não-fatal):", err));

    try {
      await ensureInboundAiAttendance({
        conversationId: conversation.id,
        contactId: contact.id,
      });
    } catch (err) {
      log.error("Falha no ensureInboundAiAttendance:", err);
    }

    try {
      await processSalesbotMessage(contact.id, parsed.text, {
        channelId,
        conversationId: conversation.id,
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
      void scheduleAiReply({
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
