import { prisma } from "@/lib/prisma";

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ChannelSessionInfo = {
  active: boolean;
  lastInboundAt: Date | null;
  expiresAt: Date | null;
};

export function sessionFromLastInbound(
  lastInboundAt: Date | null,
  now = Date.now(),
): ChannelSessionInfo {
  const diffMs = lastInboundAt ? now - lastInboundAt.getTime() : null;
  const active = diffMs !== null ? diffMs < SESSION_WINDOW_MS : false;
  const expiresAt = lastInboundAt
    ? new Date(lastInboundAt.getTime() + SESSION_WINDOW_MS)
    : null;
  return { active, lastInboundAt, expiresAt };
}

/**
 * Corte da janela 24h no canal. Gravado em `config.sessionResetAt` quando
 * o `phoneNumberId` (ou a WABA) muda — a Meta trata o número na BM nova
 * como outra identidade; inbound anterior não reabre texto livre.
 */
export function parseSessionResetAt(config: unknown): Date | null {
  if (!config || typeof config !== "object") return null;
  const raw = (config as Record<string, unknown>).sessionResetAt;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function channelMessagingIdentity(config: Record<string, unknown>): {
  phoneNumberId: string;
  wabaId: string;
} {
  const phoneNumberId =
    typeof config.phoneNumberId === "string" ? config.phoneNumberId.trim() : "";
  const wabaRaw = config.businessAccountId ?? config.wabaId;
  const wabaId = typeof wabaRaw === "string" ? wabaRaw.trim() : "";
  return { phoneNumberId, wabaId };
}

/**
 * Na troca de phoneNumberId/WABA, carimba `sessionResetAt`. Em reconnect
 * só de token, preserva o corte anterior (o provision substitui o config).
 * Não persiste `resetSessionWindow`.
 */
export function applySessionResetOnIdentityChange(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
  now = new Date(),
): Record<string, unknown> {
  const next = { ...incoming };
  delete next.resetSessionWindow;
  const prevId = channelMessagingIdentity(previous);
  const nextId = channelMessagingIdentity(next);
  const identityChanged =
    (Boolean(prevId.phoneNumberId) &&
      Boolean(nextId.phoneNumberId) &&
      prevId.phoneNumberId !== nextId.phoneNumberId) ||
    (Boolean(prevId.wabaId) &&
      Boolean(nextId.wabaId) &&
      prevId.wabaId !== nextId.wabaId);
  if (identityChanged) {
    next.sessionResetAt = now.toISOString();
    return next;
  }
  if (typeof next.sessionResetAt !== "string" || !next.sessionResetAt.trim()) {
    if (
      typeof previous.sessionResetAt === "string" &&
      previous.sessionResetAt.trim()
    ) {
      next.sessionResetAt = previous.sessionResetAt;
    }
  }
  return next;
}

function inboundAfterReset(
  lastInboundAt: Date | null,
  resetAt: Date | null,
): Date | null {
  if (!lastInboundAt) return null;
  if (resetAt && lastInboundAt.getTime() < resetAt.getTime()) return null;
  return lastInboundAt;
}

/**
 * Última inbound real do contato naquele Channel (número Meta).
 *
 * Não usa `conversations.lastInboundAt` — a coluna fica stale (replay,
 * troca de channelId no ticket, history=1) e o composer mostra 24h
 * fechada com bolha de hoje no chat.
 *
 * Janela da Meta é por (aluno, phone_number_id). `message.channelId`
 * prevalece; mensagens antigas sem snapshot caem no `channelId` atual
 * da conversa. Inbound anterior a `config.sessionResetAt` não conta.
 */
async function lastInboundOnChannel(
  contactId: string,
  channelId: string,
  opts?: { conversationId?: string },
): Promise<Date | null> {
  const ticketInbound =
    opts?.conversationId != null
      ? [
          {
            conversationId: opts.conversationId,
            OR: [{ channelId }, { channelId: null }],
          },
        ]
      : [];
  const [lastInMsg, channel] = await Promise.all([
    prisma.message.findFirst({
      where: {
        direction: "in",
        AND: [
          { conversation: { contactId } },
          {
            OR: [
              { channelId },
              { AND: [{ channelId: null }, { conversation: { channelId } }] },
              ...ticketInbound,
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.channel.findUnique({
      where: { id: channelId },
      select: { config: true },
    }),
  ]);
  return inboundAfterReset(
    lastInMsg?.createdAt ?? null,
    parseSessionResetAt(channel?.config),
  );
}

/**
 * Janela de 24h no canal da própria conversa. Sempre deriva das
 * mensagens inbound — nunca da coluna desnormalizada.
 */
export async function getConversationSession(conv: {
  id: string;
  contactId: string | null;
  channel: string;
  channelId?: string | null;
  lastInboundAt?: Date | null;
}): Promise<ChannelSessionInfo> {
  if (conv.contactId && conv.channelId) {
    return getContactChannelSession(conv.contactId, conv.channelId, {
      conversationId: conv.id,
    });
  }

  const lastInMsg = await prisma.message.findFirst({
    where: {
      direction: "in",
      conversation: conv.contactId
        ? { contactId: conv.contactId, channel: conv.channel }
        : { id: conv.id },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  let lastInboundAt = lastInMsg?.createdAt ?? null;
  if (lastInboundAt && conv.channelId) {
    const channel = await prisma.channel.findUnique({
      where: { id: conv.channelId },
      select: { config: true },
    });
    lastInboundAt = inboundAfterReset(
      lastInboundAt,
      parseSessionResetAt(channel?.config),
    );
  }
  return sessionFromLastInbound(lastInboundAt);
}

/**
 * Janela de 24h da Meta para o par (contato, canal = número).
 */
export async function getContactChannelSession(
  contactId: string,
  channelId: string,
  opts?: { conversationId?: string },
): Promise<ChannelSessionInfo> {
  const lastInboundAt = await lastInboundOnChannel(contactId, channelId, opts);
  return sessionFromLastInbound(lastInboundAt);
}
