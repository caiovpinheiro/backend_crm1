/** Grace antes do card sair da fila humana para Automação. */
export const AUTOMATION_QUEUE_DELAY_MS = 15_000;

export function automationQueueDelayAgo(now = Date.now()): Date {
  return new Date(now - AUTOMATION_QUEUE_DELAY_MS);
}
