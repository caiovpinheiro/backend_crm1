/**
 * Eventos de atividade no chat da conversa (timeline do inbox).
 *
 * Distintos de notas internas (`messageType=note`): EVENT é ação automática
 * do sistema/agente IA; NOTE é anotação manual de um humano.
 *
 * Persistidos como `Message` com `messageType = "event:{action}"` — o campo
 * já é string livre, sem migration. `isPrivate=true` para não ir ao cliente
 * nem virar preview da lista.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { sseBus } from "@/lib/sse-bus";

export const CONVERSATION_EVENT_ACTIONS = [
  "distribuicao",
  "atribuicao",
  "transferencia",
  "status",
  "tabulacao",
  "tag",
  "entrada",
  "saida",
  "ia",
  "template",
] as const;

export type ConversationEventAction =
  (typeof CONVERSATION_EVENT_ACTIONS)[number];

export const EVENT_MESSAGE_TYPE_PREFIX = "event:";

export function eventMessageType(action: ConversationEventAction): string {
  return `${EVENT_MESSAGE_TYPE_PREFIX}${action}`;
}

export function isEventMessageType(
  messageType: string | null | undefined,
): boolean {
  if (!messageType) return false;
  return (
    messageType === "event" ||
    messageType.startsWith(EVENT_MESSAGE_TYPE_PREFIX)
  );
}

/** Texto curto do evento de fila. Motivo técnico fica no meta/logs. */
export function queueWaitingConsultantText(
  departmentName?: string | null,
): string {
  const dept = (departmentName ?? "").trim();
  return dept
    ? `Enfileirada em ${dept} — sem consultor elegível`
    : "Enfileirada — sem consultor elegível";
}

/** Remove códigos SCREAMING_SNAKE e encurta copy legado de fila. */
function stripReasonCodesFromChatText(text: string): string {
  let t = text
    .replace(/\s*\([A-Z][A-Z0-9]*(_[A-Z0-9]+)+\)/g, "")
    .replace(/\s+[A-Z][A-Z0-9]*(_[A-Z0-9]+)+(?=\s|$)/g, "")
    .replace(/^Conversa enfileirada para\s+/i, "Enfileirada em ")
    .replace(/aguardando consultor elegível/gi, "sem consultor elegível")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+[—–-]\s*$/g, "")
    .trim();
  if (/^aguardando consultor/i.test(t) || /^sem consultor elegível$/i.test(t)) {
    return "Enfileirada — sem consultor elegível";
  }
  return t;
}

export async function createConversationEvent(args: {
  conversationId: string;
  action: ConversationEventAction;
  text: string;
  actor: string;
  /** User.id do agente humano — vai no SSE; o nome já vai em senderName. */
  actorUserId?: string | null;
  authorType?: "bot" | "system";
  /** Se houver mensagem recente com um destes prefixos, não duplica. */
  dedupeStartsWith?: string[];
  dedupeWindowMs?: number;
}): Promise<{ id: string } | null> {
  const text = stripReasonCodesFromChatText(args.text);
  if (!text) return null;

  const authorType = args.authorType ?? "system";
  const actor =
    args.actor.trim() || (authorType === "bot" ? "Agente IA" : "Sistema");

  if (args.dedupeStartsWith?.length && (args.dedupeWindowMs ?? 0) > 0) {
    const since = new Date(Date.now() - args.dedupeWindowMs!);
    const existing = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        isPrivate: true,
        createdAt: { gte: since },
        AND: [
          {
            OR: [
              { messageType: "note" },
              { messageType: "event" },
              { messageType: { startsWith: EVENT_MESSAGE_TYPE_PREFIX } },
            ],
          },
          {
            OR: args.dedupeStartsWith.map((prefix) => ({
              content: { startsWith: prefix },
            })),
          },
        ],
      },
      select: { id: true },
    });
    if (existing) return existing;
  }

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: args.conversationId,
      content: text,
      direction: "out",
      messageType: eventMessageType(args.action),
      isPrivate: true,
      authorType,
      senderName: actor,
      sendStatus: "sent",
    }),
  });

  const conv = await prisma.conversation
    .findUnique({
      where: { id: args.conversationId },
      select: { contactId: true, organizationId: true },
    })
    .catch(() => null);

  sseBus.publish("new_message", {
    organizationId: conv?.organizationId ?? getOrgIdOrNull(),
    conversationId: args.conversationId,
    contactId: conv?.contactId ?? null,
    direction: "out",
    messageType: saved.messageType,
    content: text,
    timestamp: saved.createdAt,
    senderName: actor,
    senderUserId: args.actorUserId ?? null,
  });

  return { id: saved.id };
}
