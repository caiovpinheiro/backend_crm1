/**
 * Webchat v2 — SSE do painel "No site agora" (docs/decisoes/webchat-widget.md
 * §9.3). Publicadores best-effort (falha de SSE nunca derruba a gravação).
 * Só publica para dono identificado: o inbox mostra contato, não visitante
 * anônimo. A frente C (servidor a servidor) reusa `publishWebchatContextChange`
 * depois de `writeLiveContext`.
 *
 * Eventos (nome SSE → payload):
 *  - `webchat_context` → `{ organizationId, contactId, channelId, state, updatedAt }`
 *  - `webchat_event`   → `{ organizationId, contactId, channelId, event: { id, name, data, important, occurredAt } }`
 */
import { getLogger } from "@/lib/logger";
import { publishWebchatContext, publishWebchatEvent } from "@/lib/realtime-events";
import type { WebchatContextState } from "@/lib/webchat/live-context";
import { WEBCHAT_RECENT_EVENTS } from "@/lib/webchat/v2-config";

const log = getLogger("webchat-tracking");

export type WebchatEventDto = {
  id: string;
  name: string;
  data: WebchatContextState | null;
  important: boolean;
  /** ISO */
  occurredAt: string;
};

/** Estado novo do contexto vivo do contato → inbox. */
export function publishWebchatContextChange(args: {
  organizationId: string;
  channelId: string;
  contactId: string | null;
  state: WebchatContextState;
  updatedAt: Date;
}): void {
  if (!args.contactId) return;
  try {
    publishWebchatContext({
      organizationId: args.organizationId,
      contactId: args.contactId,
      channelId: args.channelId,
      state: args.state,
      updatedAt: args.updatedAt.toISOString(),
    });
  } catch (err) {
    log.debug({ err }, "SSE webchat_context falhou (não-fatal)");
  }
}

/**
 * Eventos novos → inbox, um SSE por evento, só os `WEBCHAT_RECENT_EVENTS`
 * mais recentes do lote (o painel mostra só esses).
 */
export function publishWebchatEventsAdded(args: {
  organizationId: string;
  channelId: string;
  contactId: string | null;
  events: WebchatEventDto[];
}): void {
  if (!args.contactId || args.events.length === 0) return;
  const newest = [...args.events]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, WEBCHAT_RECENT_EVENTS)
    .reverse();
  for (const event of newest) {
    try {
      publishWebchatEvent({
        organizationId: args.organizationId,
        contactId: args.contactId,
        channelId: args.channelId,
        event,
      });
    } catch (err) {
      log.debug({ err }, "SSE webchat_event falhou (não-fatal)");
      return;
    }
  }
}
