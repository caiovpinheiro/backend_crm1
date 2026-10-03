import { markNowRelative } from "@/lib/cache/now-relative";

/** Grace antes do card sair da fila humana para Automação. */
export const AUTOMATION_QUEUE_DELAY_MS = 15_000;

/**
 * Corte da fila Automação. Marcado como relativo ao agora: a chave do cache
 * dos contadores do Inbox usa o rótulo, não o instante (ver
 * `inboxTabCountsFingerprint`).
 */
export function automationQueueDelayAgo(now = Date.now()): Date {
  return markNowRelative(
    new Date(now - AUTOMATION_QUEUE_DELAY_MS),
    "automation_queue_delay",
  );
}
