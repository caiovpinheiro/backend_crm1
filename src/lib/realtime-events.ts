import { sseBus } from "@/lib/sse-bus";

/**
 * Eventos SSE "leves" do chat — `typing` e `scheduled_message_updated`.
 * Contrato completo no cabeçalho de `sse-bus.ts`. Aqui ficam os
 * publishers (um ponto só por evento) e o throttle do `typing`.
 */

/** Janela mínima entre dois `typing` do mesmo agente na mesma conversa. */
export const TYPING_THROTTLE_MS = 3_000;
/** Quanto tempo o cliente mostra "digitando…" a partir de cada evento. */
export const TYPING_TTL_MS = 5_000;

export type TypingEventPayload = {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  /** Quem está digitando. `null` quando é o contato (reservado). */
  userId: string | null;
  userName: string | null;
  source: "agent" | "contact";
  /** ISO: o cliente esconde o indicador quando passa deste instante. */
  until: string;
};

export type ScheduledMessageUpdatedPayload = {
  organizationId: string;
  conversationId: string;
  scheduledMessageId: string | null;
  /** Estado que motivou o evento. */
  status: "PENDING" | "CANCELLED" | "SENT" | "FAILED";
};

// `${conversationId}:${userId}` → epoch ms do último evento publicado.
// Chave por agente (e não só por conversa) de propósito: dois agentes
// digitando ao mesmo tempo na mesma conversa precisam aparecer um para
// o outro; com a chave só por conversa o segundo cairia sempre no
// throttle do primeiro.
const lastTypingAt = new Map<string, number>();
const TYPING_MAP_PRUNE_AT = 2_000;

function pruneTypingMap(now: number): void {
  if (lastTypingAt.size < TYPING_MAP_PRUNE_AT) return;
  for (const [key, at] of lastTypingAt) {
    if (now - at > TYPING_THROTTLE_MS) lastTypingAt.delete(key);
  }
}

/** Só para testes: zera o throttle. */
export function __resetTypingThrottleForTests(): void {
  lastTypingAt.clear();
}

/**
 * Publica `typing` para a org, no máximo 1 a cada `TYPING_THROTTLE_MS`
 * por (conversa, agente). Devolve `true` quando publicou.
 */
export function publishTypingEvent(args: {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  userId: string | null;
  userName?: string | null;
  source?: "agent" | "contact";
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  const key = `${args.conversationId}:${args.userId ?? "contact"}`;
  const last = lastTypingAt.get(key);
  if (last !== undefined && now - last < TYPING_THROTTLE_MS) return false;
  lastTypingAt.set(key, now);
  pruneTypingMap(now);

  const payload: TypingEventPayload = {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    userId: args.userId,
    userName: args.userName?.trim() || null,
    source: args.source ?? "agent",
    until: new Date(now + TYPING_TTL_MS).toISOString(),
  };
  sseBus.publish("typing", payload);
  return true;
}

/**
 * Publica `scheduled_message_updated` — a lista de agendamentos pendentes
 * da conversa mudou (criado, cancelado, enviado ou falhou). O cliente só
 * invalida a query; não há payload de item.
 */
export function publishScheduledMessageUpdated(args: {
  organizationId: string | null | undefined;
  conversationId: string;
  scheduledMessageId?: string | null;
  status: ScheduledMessageUpdatedPayload["status"];
}): void {
  if (!args.organizationId) return;
  const payload: ScheduledMessageUpdatedPayload = {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    scheduledMessageId: args.scheduledMessageId ?? null,
    status: args.status,
  };
  sseBus.publish("scheduled_message_updated", payload);
}
