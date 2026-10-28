/**
 * Webchat v2 — SSE do painel "No site agora" (docs/decisoes/webchat-widget.md
 * §9.3). Publicadores best-effort (falha de SSE nunca derruba a gravação).
 * Só publica para dono identificado: o inbox mostra contato, não visitante
 * anônimo. A frente C (servidor a servidor) reusa `publishWebchatContextChange`
 * depois de `writeLiveContext`.
 *
 * Privacidade: o bus entrega por organização, então os eventos saem só como
 * SINAL DE INVALIDAÇÃO, sem valores do site. Quem tem o painel da conversa
 * aberto refaz o `GET /api/conversations/:id/webchat-context` (que confere o
 * acesso à conversa); quem não pode ver a conversa não recebe nada além de ids.
 *
 * Eventos (nome SSE → payload):
 *  - `webchat_context` → `{ organizationId, contactId, channelId, updatedAt }`
 *  - `webchat_event`   → `{ organizationId, contactId, channelId, count, latestOccurredAt }` (um por lote)
 */
import { getLogger } from "@/lib/logger";
import { publishWebchatContext, publishWebchatEvent } from "@/lib/realtime-events";
import type { WebchatContextState } from "@/lib/webchat/live-context";

const log = getLogger("webchat-tracking");

export type WebchatEventDto = {
  id: string;
  name: string;
  data: WebchatContextState | null;
  important: boolean;
  /** ISO */
  occurredAt: string;
};

/**
 * Estado novo do contexto vivo do contato → sinal para o inbox. `state` é
 * aceito para manter a assinatura dos chamadores, mas NÃO sai no SSE.
 */
export function publishWebchatContextChange(args: {
  organizationId: string;
  channelId: string;
  contactId: string | null;
  state?: WebchatContextState;
  updatedAt: Date;
}): void {
  if (!args.contactId) return;
  try {
    publishWebchatContext({
      organizationId: args.organizationId,
      contactId: args.contactId,
      channelId: args.channelId,
      updatedAt: args.updatedAt.toISOString(),
    });
  } catch (err) {
    log.debug({ err }, "SSE webchat_context falhou (não-fatal)");
  }
}

/** Eventos novos → um sinal por lote (sem nome nem dados dos eventos). */
export function publishWebchatEventsAdded(args: {
  organizationId: string;
  channelId: string;
  contactId: string | null;
  events: Array<Pick<WebchatEventDto, "occurredAt">>;
}): void {
  if (!args.contactId || args.events.length === 0) return;
  const latestOccurredAt = args.events
    .map((e) => e.occurredAt)
    .reduce((a, b) => (b > a ? b : a));
  try {
    publishWebchatEvent({
      organizationId: args.organizationId,
      contactId: args.contactId,
      channelId: args.channelId,
      count: args.events.length,
      latestOccurredAt,
    });
  } catch (err) {
    log.debug({ err }, "SSE webchat_event falhou (não-fatal)");
  }
}
