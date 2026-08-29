import {
  DEFAULT_ORG_RATE_LIMIT_RPM,
  ORG_RATE_LIMIT_WINDOW_MS,
} from "@/lib/org-rate-limit-config";

const DEFAULT_LIMIT = DEFAULT_ORG_RATE_LIMIT_RPM;
const DEFAULT_WINDOW_MS = ORG_RATE_LIMIT_WINDOW_MS;
const CLEANUP_INTERVAL = 120_000;

type BucketEntry = {
  timestamps: number[];
  // janela usada na ultima escrita; cleanup precisa do max das janelas
  // pra nao deletar timestamps que ainda contam pra alguem.
  windowMs: number;
};

const buckets = new Map<string, BucketEntry>();

let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of buckets) {
    const cutoff = now - entry.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) buckets.delete(key);
  }
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetInSeconds: number;
};

/**
 * Rate limit em memoria por processo. NAO funciona em N replicas — em prod
 * com 2+ instancias do app, o limite efetivo e N*limit. Aceitavel pra
 * signup self-service (proteger contra abuse simples) mas nao pra cobranca
 * ou fluxos sensiveis. Pra distribuido, use Upstash Redis no futuro.
 *
 * @param windowMs Janela em ms; default 60s.
 */
export function resetRateLimitMemory(): void {
  buckets.clear();
  lastCleanup = 0;
}

export function checkRateLimit(
  key: string,
  limit: number = DEFAULT_LIMIT,
  windowMs: number = DEFAULT_WINDOW_MS,
  now: number = Date.now(),
): RateLimitResult {
  cleanup();

  const cutoff = now - windowMs;

  let entry = buckets.get(key);
  if (!entry) {
    entry = { timestamps: [], windowMs };
    buckets.set(key, entry);
  } else {
    entry.windowMs = windowMs;
  }

  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  const remaining = Math.max(0, limit - entry.timestamps.length);
  const oldestInWindow = entry.timestamps[0] ?? now;
  const resetInSeconds = Math.ceil((oldestInWindow + windowMs - now) / 1000);

  if (entry.timestamps.length >= limit) {
    return { allowed: false, limit, remaining: 0, resetInSeconds };
  }

  entry.timestamps.push(now);
  return { allowed: true, limit, remaining: remaining - 1, resetInSeconds };
}

export function setRateLimitHeaders(
  headers: Headers,
  result: RateLimitResult
): void {
  headers.set("X-RateLimit-Limit", String(result.limit));
  headers.set("X-RateLimit-Remaining", String(result.remaining));
  headers.set("X-RateLimit-Reset", String(result.resetInSeconds));
  if (!result.allowed) {
    headers.set("Retry-After", String(result.resetInSeconds));
  }
}
