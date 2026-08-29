/**
 * Agrega logs de 429 (rate-limit) por chave (IP / token / org).
 *
 * Sob flood, `withRateLimit` e o teto por org emitiam 1 JSON/rejeição
 * (~15 linhas/s). Aqui: 1 linha / chave / 10s, com `count` e `blockedSince`.
 * A resposta 429 continua imediata — só o I/O de log é atrasado.
 *
 * Ex.: 100 rejeições do mesmo IP em 10s → 1 linha com `count=100`.
 */

import { getLogger } from "@/lib/logger";

const log = getLogger("rate-limit");

export const RATE_LIMIT_REJECT_LOG_WINDOW_MS = 10_000;
const MAX_KEYS_DEFAULT = 2048;
const IDLE_TTL_MS_DEFAULT = 60_000;
const TOKEN_HASH_PREFIX_LEN = 12;

export type RateLimitRejectMeta = {
  profile?: string;
  scope?: string;
  route?: string;
  ip?: string;
  /** Prefixo de sha256(token) — nunca o Bearer cru. */
  tokenHashPrefix?: string;
  organizationId?: string;
  limit?: number;
  retryAfterSec?: number;
};

type Bucket = {
  count: number;
  blockedSince: number;
  lastSeenAt: number;
  meta: RateLimitRejectMeta;
};

type EmitFn = (obj: Record<string, unknown>, msg: string) => void;

let windowMs = RATE_LIMIT_REJECT_LOG_WINDOW_MS;
let maxKeys = MAX_KEYS_DEFAULT;
let idleTtlMs = IDLE_TTL_MS_DEFAULT;
let emitFn: EmitFn | null = null;

const buckets = new Map<string, Bucket>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

function emit(obj: Record<string, unknown>, msg: string): void {
  if (emitFn) {
    emitFn(obj, msg);
    return;
  }
  log.warn(obj, msg);
}

function tokenPrefixOf(hashOrKey: string): string {
  const raw = hashOrKey.startsWith("token:")
    ? hashOrKey.slice("token:".length)
    : hashOrKey;
  return raw.slice(0, TOKEN_HASH_PREFIX_LEN);
}

function publicKey(key: string, meta: RateLimitRejectMeta): string {
  if (meta.tokenHashPrefix) return `token:${meta.tokenHashPrefix}`;
  if (key.startsWith("token:")) return `token:${tokenPrefixOf(key)}`;
  return key;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

function stopTimer(): void {
  if (!flushTimer) return;
  clearInterval(flushTimer);
  flushTimer = null;
}

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushDueWindows, windowMs);
  // unref em prod pra o event loop não ficar preso; em Vitest o fake timer
  // ignora timers unref'd e o teste de 10s não dispararia.
  if (process.env.VITEST !== "true") {
    flushTimer.unref?.();
  }
}

function evictLru(now: number): void {
  if (buckets.size < maxKeys) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, b] of buckets) {
    if (b.lastSeenAt < oldestAt) {
      oldestAt = b.lastSeenAt;
      oldestKey = k;
    }
  }
  if (!oldestKey) return;
  flushBucket(oldestKey, now, true);
}

function flushBucket(key: string, now: number, drop: boolean): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  if (bucket.count > 0) {
    const meta = bucket.meta;
    const prefix = meta.tokenHashPrefix
      ? meta.tokenHashPrefix.slice(0, TOKEN_HASH_PREFIX_LEN)
      : key.startsWith("token:")
        ? tokenPrefixOf(key)
        : undefined;
    emit(
      compact({
        event: "rate_limit_rejected",
        key: publicKey(key, meta),
        count: bucket.count,
        blockedSince: new Date(bucket.blockedSince).toISOString(),
        windowMs,
        profile: meta.profile,
        scope: meta.scope,
        route: meta.route,
        ip: meta.ip,
        tokenHashPrefix: prefix,
        organizationId: meta.organizationId,
        limit: meta.limit,
        retryAfterSec: meta.retryAfterSec,
      }),
      "rate-limit excedido",
    );
    bucket.count = 0;
  }
  if (drop || now - bucket.lastSeenAt >= idleTtlMs) {
    buckets.delete(key);
  }
}

function flushDueWindows(): void {
  const now = Date.now();
  for (const key of [...buckets.keys()]) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (bucket.count > 0) {
      flushBucket(key, now, false);
    } else if (now - bucket.lastSeenAt >= idleTtlMs) {
      buckets.delete(key);
    }
  }
  if (buckets.size === 0) stopTimer();
}

/**
 * Contabiliza uma rejeição 429. Não escreve no logger até fechar a janela
 * de 10s (ou flush/evicção).
 */
export function logRateLimitReject(key: string, meta: RateLimitRejectMeta): void {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    evictLru(now);
    bucket = {
      count: 0,
      blockedSince: now,
      lastSeenAt: now,
      meta: {},
    };
    buckets.set(key, bucket);
    ensureTimer();
  }
  bucket.count += 1;
  bucket.lastSeenAt = now;
  bucket.meta = { ...bucket.meta, ...meta };
  if (meta.tokenHashPrefix) {
    bucket.meta.tokenHashPrefix = meta.tokenHashPrefix.slice(
      0,
      TOKEN_HASH_PREFIX_LEN,
    );
  }
}

/** Emite buckets pendentes (shutdown / testes). */
export function flushRateLimitRejectLogs(): void {
  const now = Date.now();
  for (const key of [...buckets.keys()]) {
    flushBucket(key, now, true);
  }
  stopTimer();
}

/** Só testes. Limpa Map/timer e opcionalmente aperta o teto de chaves. */
export function resetRateLimitRejectLogForTests(opts?: {
  maxKeys?: number;
  windowMs?: number;
  idleTtlMs?: number;
  emit?: EmitFn | null;
}): void {
  stopTimer();
  buckets.clear();
  windowMs = opts?.windowMs ?? RATE_LIMIT_REJECT_LOG_WINDOW_MS;
  maxKeys = opts?.maxKeys ?? MAX_KEYS_DEFAULT;
  idleTtlMs = opts?.idleTtlMs ?? IDLE_TTL_MS_DEFAULT;
  emitFn = opts?.emit === undefined ? null : opts.emit;
}
