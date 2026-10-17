/**
 * O que o visitante vê no widget: só as mensagens de chat dos tickets
 * webchat dele neste canal (nada de nota interna, rascunho de IA, evento ou
 * histórico de outros canais — esse histórico unificado é só do agente).
 *
 * Cursor opaco `createdAt,id` (base64url) — ordem estável mesmo com duas
 * mensagens no mesmo milissegundo. Roda dentro de `withSystemContext`.
 */
import type { Prisma } from "@prisma/client";

import { noteMessageChanges } from "@/lib/cache/message-versions";
import { NON_CHAT_MESSAGE_TYPES } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { publishMessageStatus } from "@/lib/realtime-events";
import { isWebchatAgentTyping } from "@/lib/webchat/agent-typing";
import { WEBCHAT_CONVERSATION_CHANNEL } from "@/lib/webchat/inbound";

export const VISITOR_MESSAGES_PAGE = 50;

export type VisitorMessageDto = {
  id: string;
  /** Só nas mensagens do visitante (`in`): o id que o widget mandou. */
  clientMessageId: string | null;
  direction: "in" | "out";
  content: string;
  messageType: string;
  mediaUrl: string | null;
  createdAt: string;
  /** Nome de quem respondeu (`out`); null nas do visitante. */
  senderName: string | null;
  authorType: "human" | "bot" | "system";
  /** `out`: sent | delivered | read | failed. `in`: null. */
  status: string | null;
};

type Row = {
  id: string;
  conversationId: string;
  externalId: string | null;
  direction: string;
  content: string;
  messageType: string;
  mediaUrl: string | null;
  createdAt: Date;
  senderName: string | null;
  authorType: string;
  sendStatus: string;
};

const ROW_SELECT = {
  id: true,
  conversationId: true,
  externalId: true,
  direction: true,
  content: true,
  messageType: true,
  mediaUrl: true,
  createdAt: true,
  senderName: true,
  authorType: true,
  sendStatus: true,
} as const;

export function encodeVisitorCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()},${id}`, "utf8").toString("base64url");
}

export function decodeVisitorCursor(raw: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const comma = decoded.indexOf(",");
  if (comma <= 0) return null;
  const createdAt = new Date(decoded.slice(0, comma));
  const id = decoded.slice(comma + 1);
  if (Number.isNaN(createdAt.getTime()) || !id || id.length > 64) return null;
  return { createdAt, id };
}

const RAW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `after` do widget: o cursor opaco que devolvemos ou, como fallback, o `id`
 * da última mensagem que ele tem (`VisitorMessageDto.id`). `undefined` =
 * nem um nem outro (400); `null` = sem `after`.
 */
export async function resolveVisitorCursor(
  raw: string | null,
  contactId: string | null,
  channelId: string,
): Promise<{ createdAt: Date; id: string } | null | undefined> {
  if (!raw) return null;
  const decoded = decodeVisitorCursor(raw);
  if (decoded) return decoded;
  if (!RAW_ID_RE.test(raw) || !contactId) return undefined;
  const ref = await prisma.message.findFirst({
    where: { AND: [visitorMessageWhere(contactId, channelId), { id: raw }] },
    select: { id: true, createdAt: true },
  });
  return ref ? { createdAt: ref.createdAt, id: ref.id } : undefined;
}

/** Recorte de mensagens de chat visíveis ao visitante. */
export function visitorMessageWhere(contactId: string, channelId: string): Prisma.MessageWhereInput {
  return {
    conversation: { contactId, channel: WEBCHAT_CONVERSATION_CHANNEL, channelId },
    isPrivate: false,
    direction: { in: ["in", "out"] },
    messageType: { notIn: [...NON_CHAT_MESSAGE_TYPES] },
    NOT: { messageType: { startsWith: "event" } },
  };
}

function clientIdFrom(externalId: string | null, visitorPrefix: string): string | null {
  if (!externalId || !externalId.startsWith(visitorPrefix)) return null;
  return externalId.slice(visitorPrefix.length) || null;
}

function toDto(r: Row, visitorPrefix: string): VisitorMessageDto {
  const out = r.direction === "out";
  return {
    id: r.id,
    clientMessageId: out ? null : clientIdFrom(r.externalId, visitorPrefix),
    direction: out ? "out" : "in",
    content: r.content,
    messageType: r.messageType,
    mediaUrl: r.mediaUrl,
    createdAt: r.createdAt.toISOString(),
    senderName: out ? r.senderName : null,
    authorType: (["human", "bot", "system"].includes(r.authorType) ? r.authorType : "human") as
      | "human"
      | "bot"
      | "system",
    status: out ? r.sendStatus : null,
  };
}

/**
 * `after` ausente → as últimas `limit` (ordem cronológica). Com `after` →
 * as seguintes ao cursor. `cursor` da resposta = última devolvida (ou o
 * próprio `after` se não veio nada), para o próximo poll.
 */
export async function listVisitorMessages(args: {
  organizationId: string;
  visitorId: string;
  contactId: string | null;
  channelId: string;
  after: { createdAt: Date; id: string } | null;
  afterRaw: string | null;
  limit?: number;
}): Promise<{
  messages: VisitorMessageDto[];
  cursor: string | null;
  hasMore: boolean;
  /** Agente digitando agora no ticket aberto (TTL curto). */
  agentTyping: boolean;
  /** Última vez que um agente abriu o ticket aberto (`Conversation.lastReadAt`). */
  agentReadAt: string | null;
}> {
  const limit = args.limit ?? VISITOR_MESSAGES_PAGE;
  if (!args.contactId) {
    return { messages: [], cursor: args.afterRaw, hasMore: false, agentTyping: false, agentReadAt: null };
  }
  const base = visitorMessageWhere(args.contactId, args.channelId);
  let rows: Row[];
  let hasMore: boolean;
  if (args.after) {
    const { createdAt, id } = args.after;
    const found = (await prisma.message.findMany({
      where: {
        AND: [
          base,
          { OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }] },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: ROW_SELECT,
    })) as Row[];
    hasMore = found.length > limit;
    rows = found.slice(0, limit);
  } else {
    const found = (await prisma.message.findMany({
      where: base,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: ROW_SELECT,
    })) as Row[];
    // `hasMore` aqui = há mensagens mais antigas que a página (o widget v1
    // não pagina para trás; fica para quando houver scroll-up).
    hasMore = found.length > limit;
    rows = found.slice(0, limit).reverse();
  }

  await markDelivered(args.organizationId, rows);

  const open = await prisma.conversation.findFirst({
    where: {
      contactId: args.contactId,
      channel: WEBCHAT_CONVERSATION_CHANNEL,
      channelId: args.channelId,
      status: { not: "RESOLVED" },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, lastReadAt: true },
  });
  const agentTyping = open ? await isWebchatAgentTyping(args.organizationId, open.id) : false;

  const prefix = `wc:${args.visitorId}:`;
  const last = rows[rows.length - 1];
  return {
    messages: rows.map((r) => toDto(r, prefix)),
    cursor: last ? encodeVisitorCursor(last.createdAt, last.id) : args.afterRaw,
    hasMore,
    agentTyping,
    agentReadAt: open?.lastReadAt ? open.lastReadAt.toISOString() : null,
  };
}

/** `out` que o widget acabou de buscar: sent → delivered (✓✓ no inbox). */
async function markDelivered(organizationId: string, rows: Row[]): Promise<void> {
  const pending = rows.filter((r) => r.direction === "out" && r.sendStatus === "sent");
  if (pending.length === 0) return;
  const ids = pending.map((r) => r.id);
  await prisma.message.updateMany({
    where: { id: { in: ids }, sendStatus: "sent" },
    data: { sendStatus: "delivered" },
  });
  void noteMessageChanges(statusChanges(organizationId, pending));
  for (const r of pending) r.sendStatus = "delivered";
  publishStatuses(organizationId, pending, "delivered");
}

function publishStatuses(organizationId: string, rows: Row[], status: string): void {
  for (const r of rows) {
    try {
      publishMessageStatus({
        organizationId,
        conversationId: r.conversationId,
        messageId: r.externalId ?? r.id,
        internalId: r.id,
        status,
      });
    } catch {
      /* best-effort */
    }
  }
}

/** Bump das versões do inbox (sem isso o `GET` do agente daria 304 velho). */
function statusChanges(organizationId: string, rows: Row[]) {
  return rows.map((r) => ({
    organizationId,
    conversationId: r.conversationId,
    kind: "upd" as const,
    ids: [r.id, r.externalId],
  }));
}

/**
 * Visitante leu: `out` ainda não lidas até `upToMessageId` (inclusive; sem
 * ele, todas) → read. Devolve quantas mudaram.
 */
export async function markVisitorRead(args: {
  organizationId: string;
  contactId: string | null;
  channelId: string;
  upToMessageId: string | null;
}): Promise<number> {
  if (!args.contactId) return 0;
  const base = visitorMessageWhere(args.contactId, args.channelId);
  let until: Date | null = null;
  if (args.upToMessageId) {
    const ref = await prisma.message.findFirst({
      where: { AND: [base, { id: args.upToMessageId }] },
      select: { createdAt: true },
    });
    if (!ref) return 0;
    until = ref.createdAt;
  }
  const rows = (await prisma.message.findMany({
    where: {
      AND: [
        base,
        { direction: "out", sendStatus: { in: ["sent", "delivered"] } },
        ...(until ? [{ createdAt: { lte: until } }] : []),
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: ROW_SELECT,
  })) as Row[];
  if (rows.length === 0) return 0;
  await prisma.message.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { sendStatus: "read" },
  });
  void noteMessageChanges(statusChanges(args.organizationId, rows));
  publishStatuses(args.organizationId, rows, "read");
  return rows.length;
}

/** Ticket webchat ativo do visitante neste canal (typing). */
export async function activeVisitorConversation(contactId: string | null, channelId: string) {
  if (!contactId) return null;
  return prisma.conversation.findFirst({
    where: {
      contactId,
      channel: WEBCHAT_CONVERSATION_CHANNEL,
      channelId,
      status: { not: "RESOLVED" },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, number: true, status: true },
  });
}
