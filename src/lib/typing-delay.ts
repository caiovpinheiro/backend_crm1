/**
 * "Digitando…" antes de enviar: proporcional ao texto, com piso e teto, e
 * dentro do orçamento do turno. Nenhum domínio de cliente.
 */

/**
 * Calcula o tempo em ms que o indicador "digitando…" deve ficar
 * visível antes de enviar a mensagem. Proporcional ao tamanho do
 * texto, com base mínima e cap na janela máxima que a Meta aceita
 * manter o indicator ativo (25 segundos).
 *
 * Fórmula: `max(baseMs, min(baseMs + len * perCharMs, 25_000))`
 */
export function computeTypingDelayMs(textLength: number, perCharMs: number): number {
  const base = 1500;
  const normalizedPerChar = Math.max(0, Math.min(perCharMs, 200));
  const raw = base + Math.max(0, textLength) * normalizedPerChar;
  return Math.min(Math.max(base, Math.round(raw)), 25_000);
}

/** Menor "digitando…" visível quando o turno já demorou. */
export const MIN_TYPING_MS = 800;

/**
 * "Digitando…" dentro do orçamento: no máximo `maxTypingMs` e descontando o
 * que o turno já levou desde `turnStartedAt` (o cliente já esperou esse
 * tempo pensando). Nunca menos que MIN_TYPING_MS.
 */
export function typingDelayWithinBudget(
  delayMs: number,
  opts: { maxTypingMs?: number; turnStartedAt?: number },
  now: number = Date.now(),
): number {
  let ms = opts.maxTypingMs && opts.maxTypingMs > 0 ? Math.min(delayMs, opts.maxTypingMs) : delayMs;
  if (opts.turnStartedAt) ms -= Math.max(0, now - opts.turnStartedAt);
  return Math.max(Math.min(MIN_TYPING_MS, delayMs), Math.round(ms));
}
