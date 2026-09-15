/**
 * Slim inbox list row attached to SSE `new_message` / `conversation_updated`.
 *
 * Field: `card` — same shape as GET /api/conversations items (subset).
 * Lets the inbox prepend a ticket that is not on the current page without
 * `GET /api/conversations?ids=`. Extra fields on the envelope are additive.
 *
 * Built with one `findUnique` (conversation + contact + assignee + department).
 * No `messages` scan, no sibling inbound fill, no tag join. Preview comes
 * from the event payload when it is a real chat message.
 *
 * prismaBase: publish runs from webhooks/workers where RequestContext may
 * be missing; org is taken from the envelope.
 */

import { automationQueueDelayAgo } from "@/lib/inbox-automation-queue";
import { prismaBase } from "@/lib/prisma-base";

const INBOX_SSE_CARD_SELECT = {
  id: true,
  number: true,
  channel: true,
  channelId: true,
  status: true,
  unreadCount: true,
  hasError: true,
  hasHumanReply: true,
  hasAgentReply: true,
  lastInboundAt: true,
  lastMessageDirection: true,
  closedAt: true,
  followUpAt: true,
  updatedAt: true,
  createdAt: true,
  assignedToId: true,
  departmentId: true,
  tabulationId: true,
  pinnedNoteId: true,
  whatsappCallConsentStatus: true,
  department: {
    select: { id: true, name: true, requireTabulationOnClose: true },
  },
  assignedTo: {
    select: { id: true, name: true, avatarUrl: true, type: true },
  },
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      avatarUrl: true,
      automationContexts: {
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, createdAt: true },
        take: 1,
      },
    },
  },
} as const;

export type InboxSseCard = {
  id: string;
  number: number | null;
  channel: string;
  /** Conta do canal (WABA/página). Sem isto o FE dedupe cria 2 cards. */
  channelId: string | null;
  status: string;
  unreadCount: number;
  hasError: boolean;
  hasHumanReply: boolean;
  hasAgentReply: boolean;
  lastInboundAt: string | null;
  lastMessageDirection: string | null;
  hasActiveAutomation: boolean;
  closedAt: string | null;
  followUpAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  assignedToId: string | null;
  departmentId: string | null;
  tabulationId: string | null;
  pinnedNoteId: string | null;
  whatsappCallConsentStatus: string | null;
  department: {
    id: string;
    name: string;
    requireTabulationOnClose: boolean;
  } | null;
  assignedTo: {
    id: string;
    name: string;
    avatarUrl: string | null;
    type: string | null;
  } | null;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    avatarUrl: string | null;
  };
  lastMessageAt?: string | null;
  lastMessagePreview?: {
    content: string;
    messageType: string;
    mediaUrl: string | null;
    direction: string;
    sendStatus: string | null;
    sendError: string | null;
  } | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return null;
}

function isTimelineOrPrivatePreview(messageType: unknown): boolean {
  if (typeof messageType !== "string" || !messageType) return false;
  if (messageType === "event" || messageType.startsWith("event:")) return true;
  if (messageType === "note" || messageType === "ai_draft") return true;
  return false;
}

function previewFromEvent(
  data: Record<string, unknown>,
): InboxSseCard["lastMessagePreview"] | null {
  if (isTimelineOrPrivatePreview(data.messageType)) return null;
  const direction =
    data.direction === "in" || data.direction === "out"
      ? data.direction
      : null;
  if (!direction) return null;
  const content = typeof data.content === "string" ? data.content : "";
  return {
    content,
    messageType: typeof data.messageType === "string" ? data.messageType : "",
    mediaUrl: null,
    direction,
    sendStatus: direction === "out" ? "sent" : null,
    sendError: null,
  };
}

async function loadInboxSseCardRow(conversationId: string, organizationId: string) {
  return prismaBase.conversation.findFirst({
    where: { id: conversationId, organizationId },
    select: INBOX_SSE_CARD_SELECT,
  });
}

function rowToCard(
  row: NonNullable<Awaited<ReturnType<typeof loadInboxSseCardRow>>>,
  event: Record<string, unknown>,
): InboxSseCard {
  const preview = previewFromEvent(event);
  const eventTs = iso(event.timestamp as Date | string | undefined);
  const lastMessageAt = preview ? eventTs ?? iso(row.updatedAt) : null;
  let lastInboundAt = iso(row.lastInboundAt);
  let lastMessageDirection = row.lastMessageDirection;
  let updatedAt = iso(row.updatedAt);
  if (preview?.direction === "in" && lastMessageAt) {
    lastInboundAt = lastMessageAt;
    lastMessageDirection = "in";
    updatedAt = lastMessageAt;
  } else if (preview?.direction === "out" && lastMessageAt) {
    lastMessageDirection = "out";
    updatedAt = lastMessageAt;
  }
  // Outbound do robô NÃO é reply humano — senão o card cai em
  // Em Atendimento. Humano: a coluna já vai `true` no UPDATE antes do SSE.
  const authorType =
    typeof event.authorType === "string" ? event.authorType.toUpperCase() : "";
  const hasHumanReply =
    Boolean(row.hasHumanReply) ||
    (preview?.direction === "out" && authorType === "HUMAN");
  const hasAgentReply =
    Boolean(row.hasAgentReply) || preview?.direction === "out";
  const latest = row.contact.automationContexts?.[0];
  const ago = automationQueueDelayAgo().getTime();
  const startedAt = latest?.createdAt
    ? latest.createdAt instanceof Date
      ? latest.createdAt.getTime()
      : Date.parse(String(latest.createdAt))
    : NaN;
  const recentStart = Number.isFinite(startedAt) && startedAt > ago;
  const liveAged =
    !recentStart &&
    (latest?.status === "RUNNING" || latest?.status === "PAUSED") &&
    Number.isFinite(startedAt) &&
    startedAt <= ago;
  const assigneeType = (row.assignedTo?.type ?? "").toUpperCase();
  const lastDir = lastMessageDirection ?? row.lastMessageDirection;
  const hasActiveAutomation =
    assigneeType !== "AI" &&
    !recentStart &&
    (liveAged ||
      (hasAgentReply && !hasHumanReply && lastDir === "out"));
  return {
    id: row.id,
    number: row.number,
    channel: row.channel,
    channelId: row.channelId ?? null,
    status: row.status,
    unreadCount: row.unreadCount,
    hasError: row.hasError,
    hasHumanReply,
    hasAgentReply,
    lastInboundAt,
    lastMessageDirection,
    hasActiveAutomation,
    closedAt: iso(row.closedAt),
    followUpAt: iso(row.followUpAt),
    updatedAt,
    createdAt: iso(row.createdAt),
    assignedToId: row.assignedToId,
    departmentId: row.departmentId,
    tabulationId: row.tabulationId,
    pinnedNoteId: row.pinnedNoteId,
    whatsappCallConsentStatus: row.whatsappCallConsentStatus ?? null,
    department: row.department,
    assignedTo: row.assignedTo
      ? {
          id: row.assignedTo.id,
          name: row.assignedTo.name,
          avatarUrl: row.assignedTo.avatarUrl,
          type: row.assignedTo.type,
        }
      : null,
    contact: {
      id: row.contact.id,
      name: row.contact.name ?? "",
      phone: row.contact.phone,
      email: row.contact.email,
      avatarUrl: row.contact.avatarUrl,
    },
    ...(preview
      ? { lastMessageAt, lastMessagePreview: preview }
      : {}),
  };
}

/** True when this envelope should get a `card` (or already has one). */
export function shouldAttachInboxSseCard(
  event: string,
  data: unknown,
): boolean {
  if (event !== "new_message" && event !== "conversation_updated") return false;
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  if (rec.card && typeof rec.card === "object") return false;
  if (isTimelineOrPrivatePreview(rec.messageType)) return false;
  return typeof rec.conversationId === "string" && rec.conversationId.length > 0;
}

/**
 * Returns `data` with `card` set, or unchanged on miss/error.
 * One light select by `conversationId` + `organizationId`.
 */
export async function withInboxSseCard(
  event: string,
  data: unknown,
): Promise<unknown> {
  if (!shouldAttachInboxSseCard(event, data)) return data;
  const rec = data as Record<string, unknown>;
  const conversationId = rec.conversationId as string;
  const organizationId =
    typeof rec.organizationId === "string" ? rec.organizationId : null;
  if (!organizationId) return data;

  const row = await loadInboxSseCardRow(conversationId, organizationId);
  if (!row?.contact) return data;

  return {
    ...rec,
    card: rowToCard(row, rec),
  };
}
