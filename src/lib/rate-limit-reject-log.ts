/**
 * Agrega logs de 429 (rate-limit) por chave (IP / token / org).
 *
 * Sob flood, 1 warn / chave / janela (10s) — não 1 linha por 429.
 * A 1ª rejeição emite na hora (serverless/réplica não perde o sinal);
 * o resto da janela só incrementa `count`. Réplicas: SET NX no Redis
 * do rate-limit (sem Redis = só o teto in-memory deste processo).
 *
 * A resposta 429 continua imediata — só o I/O de log é amostrado.
 */

import { getLogger } from "@/lib/logger";

const log = getLogger("rate-limit");

export const RATE_LIMIT_REJECT_LOG_WINDOW_MS = 10_000;
const MAX_KEYS_DEFAULT = 2048;
const IDLE_TTL_MS_DEFAULT = 60_000;
const TOKEN_HASH_PREFIX_LEN = 12;
const REDIS_SAMPLE_PREFIX = "rl:reject-log:";

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
  windowStart: number;
  emitted: boolean;
  meta: RateLimitRejectMeta;
};

type EmitFn = (obj: Record<string, unknown>, msg: string) => void;

type RejectLogStore = {
  windowMs: number;
  maxKeys: number;
  idleTtlMs: number;
  emitFn: EmitFn | null;
  buckets: Map<string, Bucket>;
  flushTimer: ReturnType<typeof setInterval> | null;
};

const globalForRejectLog = globalThis as typeof globalThis & {
  __crmRateLimitRejectLog?: RejectLogStore;
};

function getStore(): RejectLogStore {
  if (!globalForRejectLog.__crmRateLimitRejectLog) {
    globalForRejectLog.__crmRateLimitRejectLog = {
      windowMs: RATE_LIMIT_REJECT_LOG_WINDOW_MS,
      maxKeys: MAX_KEYS_DEFAULT,
      idleTtlMs: IDLE_TTL_MS_DEFAULT,
      emitFn: null,
      buckets: new Map(),
      flushTimer: null,
    };
  }
  return globalForRejectLog.__crmRateLimitRejectLog;
}

function emit(obj: Record<string, unknown>, msg: string): void {
  const s = getStore();
  if (s.emitFn) {
    s.emitFn(obj, msg);
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
  const s = getStore();
  if (!s.flushTimer) return;
  clearInterval(s.flushTimer);
  s.flushTimer = null;
}

function ensureTimer(): void {
  const s = getStore();
  if (s.flushTimer) return;
  s.flushTimer = setInterval(flushDueWindows, s.windowMs);
  // unref em prod pra o event loop não ficar preso; em Vitest o fake timer
  // ignora timers unref'd e o teste de 10s não dispararia.
  if (process.env.VITEST !== "true") {
    s.flushTimer.unref?.();
  }
}

function evictLru(now: number): void {
  const s = getStore();
  if (s.buckets.size < s.maxKeys) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, b] of s.buckets) {
    if (b.lastSeenAt < oldestAt) {
      oldestAt = b.lastSeenAt;
      oldestKey = k;
    }
  }
  if (!oldestKey) return;
  flushBucket(oldestKey, now, true);
}

function bucketPayload(
  key: string,
  bucket: Bucket,
): Record<string, unknown> {
  const meta = bucket.meta;
  const prefix = meta.tokenHashPrefix
    ? meta.tokenHashPrefix.slice(0, TOKEN_HASH_PREFIX_LEN)
    : key.startsWith("token:")
      ? tokenPrefixOf(key)
      : undefined;
  return compact({
    event: "rate_limit_rejected",
    key: publicKey(key, meta),
    count: bucket.count,
    blockedSince: new Date(bucket.blockedSince).toISOString(),
    windowMs: getStore().windowMs,
    profile: meta.profile,
    scope: meta.scope,
    route: meta.route,
    ip: meta.ip,
    tokenHashPrefix: prefix,
    organizationId: meta.organizationId,
    limit: meta.limit,
    retryAfterSec: meta.retryAfterSec,
  });
}

function flushBucket(key: string, now: number, drop: boolean): void {
  const s = getStore();
  const bucket = s.buckets.get(key);
  if (!bucket) return;
  // Já emitiu nesta janela (1ª rejeição). Só solta de novo se ainda
  // não emitiu — evicção/shutdown sem o warn inicial.
  if (bucket.count > 0 && !bucket.emitted) {
    emit(bucketPayload(key, bucket), "rate-limit excedido");
    bucket.emitted = true;
  }
  if (drop || now - bucket.lastSeenAt >= s.idleTtlMs) {
    s.buckets.delete(key);
  }
}

function flushDueWindows(): void {
  const s = getStore();
  const now = Date.now();
  for (const key of [...s.buckets.keys()]) {
    const bucket = s.buckets.get(key);
    if (!bucket) continue;
    if (now - bucket.windowStart >= s.windowMs) {
      s.buckets.delete(key);
    } else if (now - bucket.lastSeenAt >= s.idleTtlMs) {
      s.buckets.delete(key);
    }
  }
  if (s.buckets.size === 0) stopTimer();
}

function shouldSkipRedisSample(): boolean {
  return process.env.VITEST === "true" || getStore().emitFn !== null;
}

function emitFirstOfWindow(key: string, bucket: Bucket): void {
  const payload = bucketPayload(key, bucket);
  if (shouldSkipRedisSample()) {
    emit(payload, "rate-limit excedido");
    return;
  }
  void (async () => {
    try {
      const { getRateLimitRedis } = await import("@/lib/rate-limit");
      const redis = getRateLimitRedis();
      if (redis) {
        const windowId = Math.floor(Date.now() / getStore().windowMs);
        const nk = `${REDIS_SAMPLE_PREFIX}${publicKey(key, bucket.meta)}:${windowId}`;
        const ok = await redis.set(
          nk,
          "1",
          "EX",
          Math.ceil(getStore().windowMs / 1000) + 2,
          "NX",
        );
        if (ok !== "OK") return;
      }
    } catch {
      /* Redis fora: emite neste processo (teto in-memory já aplicou). */
    }
    emit(payload, "rate-limit excedido");
  })();
}

/**
 * Contabiliza uma rejeição 429. 1 warn na 1ª da janela; o resto só conta.
 */
export function logRateLimitReject(key: string, meta: RateLimitRejectMeta): void {
  const s = getStore();
  const now = Date.now();
  let bucket = s.buckets.get(key);
  if (bucket && now - bucket.windowStart >= s.windowMs) {
    s.buckets.delete(key);
    bucket = undefined;
  }
  if (!bucket) {
    evictLru(now);
    bucket = {
      count: 0,
      blockedSince: now,
      lastSeenAt: now,
      windowStart: now,
      emitted: false,
      meta: {},
    };
    s.buckets.set(key, bucket);
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
  if (!bucket.emitted) {
    bucket.emitted = true;
    emitFirstOfWindow(key, bucket);
  }
}

/** Emite buckets pendentes que ainda não logaram (shutdown / testes). */
export function flushRateLimitRejectLogs(): void {
  const now = Date.now();
  const s = getStore();
  for (const key of [...s.buckets.keys()]) {
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
  const s = getStore();
  s.buckets.clear();
  s.windowMs = opts?.windowMs ?? RATE_LIMIT_REJECT_LOG_WINDOW_MS;
  s.maxKeys = opts?.maxKeys ?? MAX_KEYS_DEFAULT;
  s.idleTtlMs = opts?.idleTtlMs ?? IDLE_TTL_MS_DEFAULT;
  s.emitFn = opts?.emit === undefined ? null : opts.emit;
}
