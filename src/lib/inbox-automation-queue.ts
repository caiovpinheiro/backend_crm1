/**
 * Delay antes do card ir para a aba Automação.
 * Execução RUNNING/PAUSED com menos de 15s ainda não sai das filas humanas.
 */

export const AUTOMATION_QUEUE_DELAY_MS = 15_000;

export function automationQueueDelayAgo(now = new Date()): Date {
  return new Date(now.getTime() - AUTOMATION_QUEUE_DELAY_MS);
}
