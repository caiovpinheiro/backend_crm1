import type { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { normalizePhone, phoneMatchVariants } from "@/lib/phone";
import { insertContactWithNextNumber } from "@/services/contacts";
import {
  activeConversationOnAccountWhere,
  withConversationNumberRetry,
} from "@/services/conversations";

const log = getLogger("whatsapp-groups");

export type WhatsAppGroupMemberDto = {
  id: string;
  jid: string;
  phone: string | null;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
};

export type WhatsAppGroupListItem = {
  id: string;
  jid: string;
  name: string;
  /** Apelido interno (só no CRM). A tela mostra ele no lugar de `name`. */
  customName: string | null;
  description: string | null;
  ownerJid: string | null;
  participantCount: number;
  syncedAt: string;
  /** Última mensagem recebida ou enviada. Nulo = grupo sem mensagem no CRM. */
  lastMessageAt: string | null;
  /** Prévia da última mensagem (uma linha, já cortada). */
  lastMessagePreview: string | null;
  /** Quem mandou a última (nulo quando foi o próprio número). */
  lastMessageAuthor: string | null;
  lastMessageFromMe: boolean;
  /** Mensagens recebidas depois do último "visto" (compartilhado no número). */
  unreadCount: number;
};

export type WhatsAppGroupCompanyRef = { id: string; number: number; name: string };

export type WhatsAppGroupDetail = WhatsAppGroupListItem & {
  members: WhatsAppGroupMemberDto[];
  /** Empresa do CRM vinculada ao grupo. */
  company: WhatsAppGroupCompanyRef | null;
};

export type WhatsAppGroupMessageDto = {
  id: string;
  fromJid: string;
  fromName: string | null;
  fromPhone: string | null;
  fromMe: boolean;
  text: string;
  /** text | image | video | audio | ptt | document | sticker. */
  messageType: string;
  mediaUrl: string | null;
  mimeType: string | null;
  fileName: string | null;
  /** Reações (uma por remetente; "me" = o próprio número, enviada pelo CRM ou celular). */
  reactions: GroupReaction[];
  /** Mensagem citada (resposta). */
  replyTo: { waId: string; text: string; author: string | null } | null;
  /** Tem id do WhatsApp: dá para reagir e responder. */
  canReact: boolean;
  createdAt: string;
};

export type GroupReaction = { emoji: string; from: string; name: string | null };

/** Tipos de mensagem com arquivo — os mesmos do inbox. */
export const GROUP_MEDIA_TYPES = new Set(["image", "video", "audio", "ptt", "document", "sticker"]);

const MESSAGE_SELECT = {
  id: true,
  fromJid: true,
  fromName: true,
  fromPhone: true,
  fromMe: true,
  text: true,
  messageType: true,
  mediaUrl: true,
  mimeType: true,
  fileName: true,
  reactions: true,
  replyToWaId: true,
  replyToText: true,
  replyToAuthor: true,
  waMessageId: true,
  createdAt: true,
} as const;

/** Lê o JSON de reações com segurança (linha antiga ou corrompida = []). */
export function parseGroupReactions(raw: unknown): GroupReaction[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupReaction[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { emoji, from, name } = r as Record<string, unknown>;
    if (typeof emoji === "string" && emoji && typeof from === "string" && from) {
      out.push({ emoji, from, name: typeof name === "string" ? name : null });
    }
  }
  return out;
}

/** Aplica a reação de um remetente: troca a anterior; emoji vazio remove. */
export function nextGroupReactions(
  current: GroupReaction[],
  reaction: { from: string; emoji: string; name: string | null },
): GroupReaction[] {
  const rest = current.filter((r) => r.from !== reaction.from);
  return reaction.emoji ? [...rest, { emoji: reaction.emoji, from: reaction.from, name: reaction.name }] : rest;
}

function serializeMessage(r: {
  id: string;
  fromJid: string;
  fromName: string | null;
  fromPhone: string | null;
  fromMe: boolean;
  text: string;
  messageType: string;
  mediaUrl: string | null;
  mimeType: string | null;
  fileName: string | null;
  reactions: unknown;
  replyToWaId: string | null;
  replyToText: string | null;
  replyToAuthor: string | null;
  waMessageId: string | null;
  createdAt: Date;
}): WhatsAppGroupMessageDto {
  const { reactions, replyToWaId, replyToText, replyToAuthor, waMessageId, ...rest } = r;
  return {
    ...rest,
    reactions: parseGroupReactions(reactions),
    replyTo: replyToWaId ? { waId: replyToWaId, text: replyToText ?? "", author: replyToAuthor } : null,
    canReact: Boolean(waMessageId),
    createdAt: r.createdAt.toISOString(),
  };
}

export type BaileysGroupSnapshot = {
  jid: string;
  name: string;
  description: string | null;
  ownerJid: string | null;
  /** Tamanho informado pelo WhatsApp quando a lista de participantes vem incompleta. */
  size?: number;
  /**
   * Descoberta por histórico/chat, sem metadados. Atualiza o nome e não apaga
   * participantes que já estavam gravados.
   */
  partial?: boolean;
  members: Array<{
    jid: string;
    phone: string | null;
    name: string | null;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
};

export async function findConnectedBaileysChannel() {
  return prisma.channel.findFirst({
    where: { provider: "BAILEYS_MD", status: "CONNECTED" },
    select: { id: true, name: true, phoneNumber: true },
    orderBy: { lastConnectedAt: "desc" },
  });
}

export async function listWhatsAppGroups(channelId: string): Promise<WhatsAppGroupListItem[]> {
  const rows = await prisma.whatsAppGroup.findMany({
    where: { channelId },
    // Como no WhatsApp: quem conversou por último fica em cima.
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { name: "asc" }],
    select: {
      id: true,
      jid: true,
      name: true,
      customName: true,
      description: true,
      ownerJid: true,
      participantCount: true,
      syncedAt: true,
      lastMessageAt: true,
      lastMessagePreview: true,
      lastMessageAuthor: true,
      lastMessageFromMe: true,
      lastReadAt: true,
    },
  });
  const unread = await countUnreadByGroup(rows);
  return rows.map((r) => ({ ...serializeGroup(r), unreadCount: unread.get(r.id) ?? 0 }));
}

/** Teto do contador: acima disso a lista mostra "99+". */
export const UNREAD_COUNT_CAP = 100;

/**
 * Não lidas por grupo. Só consulta quem teve mensagem depois do último
 * "visto" (na prática, poucos grupos por vez); mensagens do próprio número
 * não contam.
 */
async function countUnreadByGroup(
  rows: Array<{ id: string; lastMessageAt: Date | null; lastReadAt: Date | null }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pending = rows.filter(
    (r) => r.lastMessageAt && (!r.lastReadAt || r.lastMessageAt > r.lastReadAt),
  );
  await Promise.all(
    pending.map(async (r) => {
      const n = await prisma.whatsAppGroupMessage.count({
        where: {
          groupId: r.id,
          fromMe: false,
          ...(r.lastReadAt ? { createdAt: { gt: r.lastReadAt } } : {}),
        },
        take: UNREAD_COUNT_CAP,
      });
      if (n > 0) out.set(r.id, n);
    }),
  );
  return out;
}

/** Alguém abriu o grupo no CRM: zera o contador para todos do número. */
export async function markWhatsAppGroupRead(groupId: string, channelId: string, at = new Date()): Promise<void> {
  await prisma.whatsAppGroup.updateMany({
    where: { id: groupId, channelId, OR: [{ lastReadAt: null }, { lastReadAt: { lt: at } }] },
    data: { lastReadAt: at },
  });
}

/** Texto da prévia na lista: uma linha, mídia com rótulo, cortado em 120. */
export function groupMessagePreviewText(msg: {
  messageType: string;
  text: string;
  fileName?: string | null;
}): string {
  const label: Record<string, string> = {
    ptt: "🎤 Áudio",
    audio: "🎤 Áudio",
    image: "📷 Foto",
    video: "🎥 Vídeo",
    sticker: "Figurinha",
  };
  const clean = msg.text.replace(/\s+/g, " ").trim();
  // Rótulo que o CRM grava quando não há legenda ("[ptt]", "📎 a.pdf").
  const placeholder = /^\[[a-z]+\]( 👁)?$/i.test(clean) || clean.startsWith("📎 ") || clean === "[áudio]";
  let out: string;
  if (msg.messageType === "document") {
    const file = `📎 ${msg.fileName?.trim() || "Arquivo"}`;
    const caption = clean.split("📎")[0]?.trim();
    out = caption ? `${file} · ${caption}` : file;
  } else if (label[msg.messageType]) {
    out = placeholder || !clean ? label[msg.messageType] : `${label[msg.messageType]} ${clean}`;
  } else {
    out = clean;
  }
  return out.length > 120 ? `${out.slice(0, 119)}…` : out;
}

export async function getWhatsAppGroup(
  id: string,
  channelId: string,
): Promise<WhatsAppGroupDetail | null> {
  const row = await prisma.whatsAppGroup.findFirst({
    where: { id, channelId },
    include: {
      members: { orderBy: [{ isSuperAdmin: "desc" }, { isAdmin: "desc" }, { name: "asc" }] },
      company: { select: { id: true, number: true, name: true } },
    },
  });
  if (!row) return null;
  const crmNames = await crmNamesByPhone(
    row.members.filter((m) => !m.name?.trim() && m.phone).map((m) => m.phone!),
  );
  return {
    ...serializeGroup(row),
    company: row.company ?? null,
    members: row.members.map((m) => ({
      id: m.id,
      jid: m.jid,
      phone: m.phone,
      // Nome do perfil do WhatsApp; sem ele, o do contato do CRM (só na tela).
      name: m.name?.trim() || (m.phone ? crmNames.get(m.phone) ?? null : null),
      isAdmin: m.isAdmin,
      isSuperAdmin: m.isSuperAdmin,
    })),
  };
}

/** Telefone do participante → nome do contato do CRM com o mesmo número. */
export async function crmNamesByPhone(phones: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (phones.length === 0) return out;
  const variantOf = new Map<string, string>();
  for (const phone of phones) {
    const normalized = normalizePhone(phone) ?? phone;
    for (const v of phoneMatchVariants(normalized)) variantOf.set(v, phone);
    variantOf.set(normalized, phone);
    variantOf.set(phone, phone);
  }
  const contacts = await prisma.contact.findMany({
    where: { phone: { in: [...variantOf.keys()] } },
    select: { phone: true, name: true },
  });
  for (const c of contacts) {
    const name = c.name?.trim();
    const original = c.phone ? variantOf.get(c.phone) : undefined;
    if (name && original && !out.has(original) && name !== c.phone) out.set(original, name);
  }
  return out;
}

/**
 * Grava o nome do perfil (pushName) no participante que mandou a mensagem.
 * Casa pelo jid (o WhatsApp pode mandar LID e o telefone como alternativo)
 * ou pelo telefone.
 */
export async function learnGroupMemberName(input: {
  groupId: string;
  jids: Array<string | null | undefined>;
  phone: string | null;
  name: string;
}): Promise<number> {
  const name = input.name.trim();
  if (!name) return 0;
  const jids = [...new Set(input.jids.filter((j): j is string => Boolean(j)))];
  const or: Array<Record<string, unknown>> = [];
  if (jids.length) or.push({ jid: { in: jids } });
  if (input.phone) or.push({ phone: input.phone });
  if (or.length === 0) return 0;
  // `NOT: { name }` sozinho exclui quem ainda não tem nome (NULL no SQL):
  // justamente o participante que mais precisa aprender o nome.
  const res = await prisma.whatsAppGroupMember.updateMany({
    where: {
      groupId: input.groupId,
      AND: [{ OR: or }, { OR: [{ name: null }, { name: { not: name } }] }],
    },
    data: { name: name.slice(0, 120) },
  });
  return res.count;
}

async function writeGroupSnapshot(
  organizationId: string,
  channelId: string,
  snap: BaileysGroupSnapshot,
): Promise<void> {
  const members = snap.members.filter((m) => m.jid);
  const count = Math.max(members.length, snap.size ?? 0);
  const name = snap.name.trim();
  const group = await prisma.whatsAppGroup.upsert({
    where: { channelId_jid: { channelId, jid: snap.jid } },
    create: {
      organizationId,
      channelId,
      jid: snap.jid,
      name: name || "Grupo",
      description: snap.description,
      ownerJid: snap.ownerJid,
      participantCount: count,
      syncedAt: new Date(),
    },
    update: {
      ...(name ? { name } : {}),
      ...(snap.partial
        ? {}
        : { description: snap.description, ownerJid: snap.ownerJid }),
      ...(count > 0 ? { participantCount: count } : {}),
      syncedAt: new Date(),
    },
    select: { id: true },
  });

  // Lista vazia não apaga: a comunidade às vezes chega sem participante
  // (jid ausente) e um erro aqui interrompia o restante do lote.
  if (snap.partial || members.length === 0) return;

  // O WhatsApp quase nunca manda nome na lista de participantes: guarda o
  // que já foi aprendido das mensagens antes de recriar a lista.
  const previous = await prisma.whatsAppGroupMember.findMany({
    where: { groupId: group.id, name: { not: null } },
    select: { jid: true, phone: true, name: true },
  });
  const known = new Map<string, string>();
  for (const p of previous) {
    if (!p.name?.trim()) continue;
    known.set(p.jid, p.name);
    if (p.phone) known.set(`tel:${p.phone}`, p.name);
  }

  await prisma.whatsAppGroupMember.deleteMany({ where: { groupId: group.id } });
  await prisma.whatsAppGroupMember.createMany({
    data: members.map((m) => ({
      organizationId,
      groupId: group.id,
      jid: m.jid,
      phone: m.phone,
      name:
        m.name?.trim() ||
        known.get(m.jid) ||
        (m.phone ? known.get(`tel:${m.phone}`) : undefined) ||
        null,
      isAdmin: m.isAdmin,
      isSuperAdmin: m.isSuperAdmin,
    })),
  });
}

export async function upsertChannelGroupSnapshots(
  organizationId: string,
  channelId: string,
  snapshots: BaileysGroupSnapshot[],
): Promise<void> {
  for (const snap of snapshots) {
    if (!snap.jid.endsWith("@g.us")) continue;
    try {
      await writeGroupSnapshot(organizationId, channelId, snap);
    } catch (err) {
      log.warn(
        { channelId, jid: snap.jid, err: err instanceof Error ? err.message : err },
        "[whatsapp-groups] grupo ignorado ao gravar",
      );
    }
  }
}

export async function replaceChannelGroups(
  organizationId: string,
  channelId: string,
  snapshots: BaileysGroupSnapshot[],
): Promise<number> {
  // Resposta vazia (socket acabou de abrir) não pode apagar a lista.
  if (snapshots.length === 0) return 0;

  const seen = snapshots.map((s) => s.jid);
  await prisma.whatsAppGroup.deleteMany({
    where: { channelId, jid: { notIn: seen } },
  });

  let written = 0;
  for (const snap of snapshots) {
    try {
      await writeGroupSnapshot(organizationId, channelId, snap);
      written++;
    } catch (err) {
      log.warn(
        { channelId, jid: snap.jid, err: err instanceof Error ? err.message : err },
        "[whatsapp-groups] grupo ignorado na sincronização",
      );
    }
  }

  return written;
}

export async function listWhatsAppGroupMessages(
  groupId: string,
  limit = 80,
): Promise<WhatsAppGroupMessageDto[]> {
  const rows = await prisma.whatsAppGroupMessage.findMany({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: MESSAGE_SELECT,
  });
  return rows.reverse().map(serializeMessage);
}

export async function appendWhatsAppGroupMessage(input: {
  organizationId: string;
  groupId: string;
  waMessageId?: string | null;
  fromJid: string;
  fromName?: string | null;
  fromPhone?: string | null;
  fromMe: boolean;
  text: string;
  messageType?: string;
  mediaUrl?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  replyTo?: { waId: string; text: string; author: string | null } | null;
}): Promise<WhatsAppGroupMessageDto | null> {
  const text = input.text.trim();
  if (!text) return null;
  const messageType =
    input.messageType && (input.messageType === "text" || GROUP_MEDIA_TYPES.has(input.messageType))
      ? input.messageType
      : "text";
  if (input.waMessageId) {
    const dup = await prisma.whatsAppGroupMessage.findFirst({
      where: { groupId: input.groupId, waMessageId: input.waMessageId },
      select: { id: true },
    });
    if (dup) return null;
  }
  const row = await prisma.whatsAppGroupMessage.create({
    data: withOrgFromCtx({
      organizationId: input.organizationId,
      groupId: input.groupId,
      waMessageId: input.waMessageId ?? null,
      fromJid: input.fromJid,
      fromName: input.fromName ?? null,
      fromPhone: input.fromPhone ?? null,
      fromMe: input.fromMe,
      text: text.slice(0, 4096),
      messageType,
      mediaUrl: input.mediaUrl ?? null,
      mimeType: input.mimeType ?? null,
      fileName: input.fileName?.slice(0, 255) ?? null,
      replyToWaId: input.replyTo?.waId ?? null,
      replyToText: input.replyTo ? input.replyTo.text.replace(/\s+/g, " ").trim().slice(0, 200) : null,
      replyToAuthor: input.replyTo?.author?.slice(0, 120) ?? null,
    }),
    select: MESSAGE_SELECT,
  });
  await bumpGroupLastMessageAt(input.groupId, row.createdAt, {
    preview: groupMessagePreviewText(row),
    author: row.fromMe ? null : row.fromName?.trim() || row.fromPhone || null,
    fromMe: row.fromMe,
  });
  return serializeMessage(row);
}

/**
 * Sobe o grupo na lista e troca a prévia, no mesmo UPDATE. Só avança:
 * mensagem antiga chegando depois não rebaixa nem troca a prévia.
 */
export async function bumpGroupLastMessageAt(
  groupId: string,
  at: Date,
  last?: { preview: string; author: string | null; fromMe: boolean },
): Promise<void> {
  await prisma.whatsAppGroup.updateMany({
    where: { id: groupId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] },
    data: {
      lastMessageAt: at,
      ...(last
        ? {
            lastMessagePreview: last.preview,
            lastMessageAuthor: last.author,
            lastMessageFromMe: last.fromMe,
          }
        : {}),
    },
  });
}

export async function findWhatsAppGroupByJid(channelId: string, jid: string) {
  return prisma.whatsAppGroup.findFirst({
    where: { channelId, jid },
    select: { id: true, organizationId: true },
  });
}

export async function openWhatsAppGroupMember(input: {
  groupId: string;
  memberId: string;
  channelId: string;
}): Promise<
  | { contactId: string; conversationId: string; dealId: string | null }
  | { error: string; status: number }
> {
  const member = await prisma.whatsAppGroupMember.findFirst({
    where: { id: input.memberId, groupId: input.groupId },
    select: { id: true, phone: true, name: true, jid: true },
  });
  if (!member) return { error: "Participante não encontrado.", status: 404 };

  const phone = normalizePhone(member.phone ?? "") ?? null;
  if (!phone) {
    return {
      error: "Este participante não tem telefone visível. Não dá para abrir no inbox.",
      status: 409,
    };
  }

  const variants = phoneMatchVariants(phone);
  let contact = await prisma.contact.findFirst({
    where: { phone: { in: variants.length ? variants : [phone] } },
    select: { id: true, name: true, phone: true, assignedToId: true },
  });
  if (!contact) {
    contact = await insertContactWithNextNumber(
      { name: member.name?.trim() || phone, phone },
      { id: true, name: true, phone: true, assignedToId: true },
    );
  }

  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { id: true, name: true },
  });

  const findOnAccount = (accountId: string | null) =>
    prisma.conversation.findFirst({
      where: activeConversationOnAccountWhere({
        contactId: contact.id,
        channel: "whatsapp",
        channelId: accountId,
      }),
      select: { id: true },
    });

  let conversation = await findOnAccount(input.channelId);
  if (!conversation) {
    conversation = await findOnAccount(null);
    if (conversation) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { channelId: input.channelId, inboxName: channel?.name ?? undefined },
      });
    }
  }
  if (!conversation) {
    conversation = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          channel: "whatsapp",
          status: "OPEN" as const,
          inboxName: channel?.name ?? null,
          contactId: contact.id,
          channelId: input.channelId,
          ...(contact.assignedToId ? { assignedToId: contact.assignedToId } : {}),
        }),
        select: { id: true },
      }),
    );
  }

  const deal = await prisma.deal.findFirst({
    where: { contactId: contact.id, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  return {
    contactId: contact.id,
    conversationId: conversation.id,
    dealId: deal?.id ?? null,
  };
}

function serializeGroup(row: {
  id: string;
  jid: string;
  name: string;
  customName?: string | null;
  description: string | null;
  ownerJid: string | null;
  participantCount: number;
  syncedAt: Date;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string | null;
  lastMessageAuthor?: string | null;
  lastMessageFromMe?: boolean;
}): WhatsAppGroupListItem {
  return {
    id: row.id,
    jid: row.jid,
    name: row.name,
    customName: row.customName ?? null,
    description: row.description,
    ownerJid: row.ownerJid,
    participantCount: row.participantCount,
    syncedAt: row.syncedAt.toISOString(),
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    lastMessagePreview: row.lastMessagePreview ?? null,
    lastMessageAuthor: row.lastMessageAuthor ?? null,
    lastMessageFromMe: row.lastMessageFromMe ?? false,
    unreadCount: 0,
  };
}

/**
 * Vincula (ou desvincula, com `null`) a empresa do CRM ao grupo. A empresa
 * precisa ser da mesma org (o prisma com escopo já filtra).
 */
export async function setWhatsAppGroupCompany(input: {
  groupId: string;
  channelId: string;
  companyId: string | null;
}): Promise<{ company: WhatsAppGroupCompanyRef | null } | { error: string; status: number }> {
  let company: WhatsAppGroupCompanyRef | null = null;
  if (input.companyId) {
    company = await prisma.company.findFirst({
      where: { id: input.companyId },
      select: { id: true, number: true, name: true },
    });
    if (!company) return { error: "Empresa não encontrada.", status: 404 };
  }
  const res = await prisma.whatsAppGroup.updateMany({
    where: { id: input.groupId, channelId: input.channelId },
    data: { companyId: company?.id ?? null },
  });
  if (res.count === 0) return { error: "Grupo não encontrado.", status: 404 };
  return { company };
}

/** Tamanho máximo do apelido interno do grupo. */
export const GROUP_CUSTOM_NAME_MAX = 100;

/**
 * Apelido interno do grupo (só no CRM; nada vai para o WhatsApp). Vazio ou
 * `null` apaga e o grupo volta a mostrar o nome do WhatsApp.
 */
export async function setWhatsAppGroupCustomName(input: {
  groupId: string;
  channelId: string;
  customName: string | null;
}): Promise<{ customName: string | null } | { error: string; status: number }> {
  const customName = input.customName?.replace(/\s+/g, " ").trim() || null;
  if (customName && customName.length > GROUP_CUSTOM_NAME_MAX) {
    return { error: `O apelido pode ter até ${GROUP_CUSTOM_NAME_MAX} caracteres.`, status: 400 };
  }
  const res = await prisma.whatsAppGroup.updateMany({
    where: { id: input.groupId, channelId: input.channelId },
    data: { customName },
  });
  if (res.count === 0) return { error: "Grupo não encontrado.", status: 404 };
  return { customName };
}

/**
 * Grupos WhatsApp de uma empresa — base para, no futuro, automação e
 * campanha "enviar pelo grupo da empresa" (pelo número QR do grupo).
 */
export async function listCompanyWhatsAppGroups(companyId: string) {
  return prisma.whatsAppGroup.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    select: { id: true, jid: true, name: true, channelId: true },
  });
}

/** Mensagem do grupo pelo id do WhatsApp (reação e resposta que chegam). */
export async function findGroupMessageByWaId(groupId: string, waMessageId: string) {
  return prisma.whatsAppGroupMessage.findFirst({
    where: { groupId, waMessageId },
    select: { id: true, text: true, fromName: true, fromPhone: true, fromMe: true, reactions: true },
  });
}

/** Mensagem do grupo pelo id do CRM (responder/reagir pela tela). */
export async function findGroupMessageForAction(groupId: string, messageId: string) {
  return prisma.whatsAppGroupMessage.findFirst({
    where: { id: messageId, groupId },
    select: {
      id: true,
      waMessageId: true,
      fromJid: true,
      fromMe: true,
      fromName: true,
      fromPhone: true,
      text: true,
      messageType: true,
      fileName: true,
      reactions: true,
    },
  });
}

/** Grava a reação de um remetente na mensagem (troca a anterior; vazio remove). */
export async function applyGroupMessageReaction(
  messageId: string,
  current: unknown,
  reaction: { from: string; emoji: string; name: string | null },
): Promise<GroupReaction[]> {
  const next = nextGroupReactions(parseGroupReactions(current), reaction);
  await prisma.whatsAppGroupMessage.update({
    where: { id: messageId },
    data: { reactions: next as unknown as Prisma.InputJsonValue },
    select: { id: true },
  });
  return next;
}

/** Autor exibido na citação ("Você" quando foi o próprio número). */
export function groupQuoteAuthor(m: { fromMe: boolean; fromName: string | null; fromPhone: string | null }): string {
  if (m.fromMe) return "Você";
  return m.fromName?.trim() || m.fromPhone || "Participante";
}

/**
 * Resposta a uma mensagem do grupo: a citação que vai ao WhatsApp e o que o
 * CRM grava para desenhar o quadro. Precisa do id do WhatsApp da original.
 */
export async function groupReplyFor(
  groupId: string,
  messageId: string,
): Promise<
  | {
      quoted: { id: string; fromMe: boolean; participant: string | null; text: string };
      replyTo: { waId: string; text: string; author: string | null };
    }
  | { error: string; status: number }
> {
  const target = await findGroupMessageForAction(groupId, messageId);
  if (!target) return { error: "Mensagem respondida não encontrada.", status: 404 };
  if (!target.waMessageId) {
    return { error: "Esta mensagem é antiga e não pode ser respondida pelo CRM.", status: 409 };
  }
  const text = groupMessagePreviewText(target);
  return {
    quoted: {
      id: target.waMessageId,
      fromMe: target.fromMe,
      participant: target.fromMe ? null : target.fromJid,
      text,
    },
    replyTo: { waId: target.waMessageId, text, author: groupQuoteAuthor(target) },
  };
}

/** Desfaz a gravação quando a mensagem não entrou na fila (não saiu no WhatsApp). */
export async function deleteGroupMessage(id: string): Promise<void> {
  await prisma.whatsAppGroupMessage.delete({ where: { id }, select: { id: true } });
}
