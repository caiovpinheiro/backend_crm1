/**
 * Gate para logs verbosos de ALTA FREQUÊNCIA (por request / por mensagem).
 *
 * Logs como `[session]` (a cada GET de mensagens), `[meta-graph]`
 * (JSON.stringify do corpo INTEIRO de cada chamada Graph — inclui o
 * catálogo de templates com centenas de itens) e `[queue] ... inline`
 * (3 linhas por `message_sent`) geram spam e custo real de CPU em
 * produção sob carga.
 *
 * Ficam DESLIGADOS por padrão em produção e LIGADOS em dev. Para
 * reativá-los temporariamente em produção, defina `DEBUG_VERBOSE_LOGS=1`.
 */
export function isVerboseLogging(): boolean {
  if (process.env.DEBUG_VERBOSE_LOGS === "1") return true;
  return process.env.NODE_ENV !== "production";
}

/** console.log condicional — só emite quando `isVerboseLogging()`. */
export function debugLog(...args: unknown[]): void {
  if (isVerboseLogging()) console.log(...args);
}

/** console.info condicional — só emite quando `isVerboseLogging()`. */
export function debugInfo(...args: unknown[]): void {
  if (isVerboseLogging()) console.info(...args);
}

/** console.warn condicional — só emite quando `isVerboseLogging()`. */
export function debugWarn(...args: unknown[]): void {
  if (isVerboseLogging()) console.warn(...args);
}
