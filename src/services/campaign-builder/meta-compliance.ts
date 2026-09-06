import {
  extractMetaErrorCode,
  isMetaTransientServiceCode,
  META_TRANSIENT_SERVICE_CODES,
} from "@/lib/meta-whatsapp/error-catalog";

/**
 * Rate limits / throughput — reenfileirar campanha com backoff.
 * 131049 NÃO entra: é filtro de marketing por destinatário; retry piora
 * qualidade da WABA e infla a taxa de falha.
 */
const META_RATE_LIMIT_RETRY_CODES = new Set([130429, 131048, 131056]);

/** União: rate-limit + falhas transitórias de serviço (code 2, 131016, …). */
export const META_RETRYABLE_CODES = new Set([
  ...META_RATE_LIMIT_RETRY_CODES,
  ...META_TRANSIENT_SERVICE_CODES,
]);

/**
 * Extrai o código Meta de uma mensagem de erro persistida.
 * Prefere o sufixo canônico `(code N, …)` de `formatMetaSendError`.
 */
export function extractMetaRetryCode(message: string): number | null {
  const labeled = extractMetaErrorCode(message);
  if (labeled !== null) return labeled;
  // Fallback legado: códigos rate-limit soltos no texto.
  const bare = message.match(/\b(130429|131048|131056)\b/);
  return bare ? Number(bare[1]) : null;
}

export function isMetaRetryableError(message: string): boolean {
  const code = extractMetaRetryCode(message);
  if (code === null) return false;
  return META_RETRYABLE_CODES.has(code) || isMetaTransientServiceCode(code);
}

export function isInside24hWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;
}

export function isWindowExpiredError(message: string): boolean {
  return message.includes("META_WINDOW_EXPIRED_24H");
}

export function shouldRetryCampaignSendError(
  message: string,
  attemptsMade: number,
  maxAttempts: number,
): boolean {
  if (isWindowExpiredError(message)) return false;
  if (!isMetaRetryableError(message)) return false;
  const normalizedMax = Math.max(1, maxAttempts);
  const currentAttempt = attemptsMade + 1;
  return currentAttempt < normalizedMax;
}
