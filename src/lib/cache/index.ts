/**
 * Cache Redis para hot configs (PR 5.1).
 *
 * Implementa o padrao **cache-aside** (look-aside) com fallback
 * in-memory: se `REDIS_URL` ausente (ou Redis morto), todas as
 * chamadas viram pass-through pro loader e o app continua funcionando.
 * Isso e essencial pra `next dev` e pra resiliencia em prod (cache
 * deve ser opcional, nao bloqueante).
 *
 * ## Quando usar
 *
 * - **SIM:** payloads que mudam raramente e sao lidos em hot path.
 *   Exemplos:
 *     - `Channel` (lookup por id em cada inbound message do webhook).
 *     - `AIAgentConfig` (lookup por userId em cada turn de bot).
 *     - `Organization.branding` (lookup por slug em cada SSR de
 *       paginas publicas).
 * - **NAO:**
 *     - Listagens grandes (kanban, conversations) — invalidacao
 *       cara, payload muda toda hora.
 *     - Counters / aggregates — usar `INCR` direto, nao este helper.
 *     - Dados sensiveis sem TTL curto (PII, tokens) — stale =
 *       leak window.
 *
 * ## Convencoes
 *
 * - Chaves prefixadas com `cache:` pra inspecao no Redis CLI.
 * - Sempre com namespace (entity) + chave estavel:
 *     `cache:channel:<id>` / `cache:ai_agent:<userId>` /
 *     `cache:org:<slug>`.
 * - TTL DEFAULT = 60s. Justificativa: balanco entre hit-rate e
 *   janela de inconsistencia. Hot configs invalidam EXPLICITAMENTE
 *   no servico de update (ver `services/channels.ts.updateChannel`)
 *   — o TTL e seguro de ultima linha pra cobrir caches orfaos
 *   (deploy de outra replica, drift de schema).
 *
 * ## Invalidacao
 *
 * Sempre que um caller modifica um recurso cacheado, **deve** chamar
 * `cache.del(key)` no mesmo path. Nao confiar exclusivamente em TTL.
 * Helpers `invalidate*` em `cache/keys.ts`.
 *
 * ## Stampede protection
 *
 * `wrap()` usa (1) singleflight in-memory no processo e (2) lock
 * distribuido `SET NX PX` entre replicas. Concurrent requests pra
 * chave fria compartilham o resultado do primeiro loader. Isso evita
 * 100 queries pro DB quando uma chave hot expira — e evita o mesmo
 * stampede quando o Redis timeouta (o lock Redis sozinho nao basta).
 *
 * ## Resiliencia
 *
 * ioredis multiplexa TODOS os GETs/SETs numa conexao so. `commandTimeout`
 * conta espera na fila: um GET grande (board ~500KB) atrasava authz/
 * inbox e disparava "Command timed out" em lote. Timeout envenena o
 * pipeline do ioredis (a resposta ainda chega). Por isso: timeout mais
 * folgado, `enableOfflineQueue: false`, reconnect no timeout, gzip em
 * payload grande, circuit breaker pra pular Redis uns segundos em vez
 * de pagar timeout em cada request.
 */
import { gzipSync, gunzipSync } from "node:zlib";

import IORedis, { type Redis as IORedisClient } from "ioredis";

import { getLogger } from "@/lib/logger";
import { metrics, safeLabel } from "@/lib/metrics";

const log = getLogger("cache");

const KEY_PREFIX = "cache:";
const LOCK_PREFIX = "cache-lock:";
const DEFAULT_TTL_SEC = 60;
const LOCK_TTL_MS = 20_000;
const STAMPEDE_RETRY_DELAY_MS = 150;
const STAMPEDE_MAX_RETRIES = 50;

const CONNECT_TIMEOUT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 2_000;
const CIRCUIT_FAILURES_TO_OPEN = 5;
const CIRCUIT_COOLDOWN_MS = 15_000;

/** Prefixos ASCII que JSON.parse nunca aceita — valores gzipados. */
const GZ_PREFIX = "gz1:";
const GZ_MIN_BYTES = 8_192;
const MAX_REDIS_VALUE_BYTES = 256_000;

let redis: IORedisClient | null = null;
let redisDisabled = false;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lastCircuitLogAt = 0;

function circuitIsOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && /timed out/i.test(err.message);
}

function resetClient(): void {
  if (!redis) return;
  const client = redis;
  redis = null;
  try {
    client.disconnect();
  } catch {
    /* best-effort */
  }
}

function noteSuccess(): void {
  consecutiveFailures = 0;
}

function noteFailure(err: unknown, key: string, op: string): void {
  consecutiveFailures += 1;
  if (isTimeoutError(err)) {
    resetClient();
  }
  if (
    consecutiveFailures === 1 ||
    consecutiveFailures === CIRCUIT_FAILURES_TO_OPEN
  ) {
    log.warn({ err, key, op, consecutiveFailures }, `[cache] ${op} falhou — fallback memoria`);
  }
  if (consecutiveFailures >= CIRCUIT_FAILURES_TO_OPEN) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    consecutiveFailures = 0;
    resetClient();
    log.warn(
      { cooldownMs: CIRCUIT_COOLDOWN_MS, key, op },
      "[cache] circuit aberto — Redis ignorado temporariamente",
    );
  }
}

function getClient(): IORedisClient | null {
  if (redisDisabled) return null;
  if (circuitIsOpen()) {
    if (Date.now() - lastCircuitLogAt > 5_000) {
      lastCircuitLogAt = Date.now();
      log.warn(
        { retryInMs: circuitOpenUntil - Date.now() },
        "[cache] circuit aberto — usando memoria",
      );
    }
    return null;
  }
  if (redis) {
    const status = redis.status;
    if (status === "end" || status === "close") {
      resetClient();
    } else {
      return redis;
    }
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    redisDisabled = true;
    log.info("[cache] REDIS_URL ausente — usando fallback in-memory.");
    return null;
  }
  try {
    redis = new IORedis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      keepAlive: 10_000,
      // ioredis 5 manda CLIENT SETINFO no handshake; conexoes presas nisso
      // ficaram 19h idle em prod e nunca ficaram ready.
      disableClientInfo: true,
      lazyConnect: false,
      retryStrategy(times) {
        if (circuitIsOpen()) return null;
        return Math.min(times * 200, 2_000);
      },
    });
    redis.on("error", (err) => {
      log.warn({ err }, "[cache] redis client error (continuando com fallback)");
      if (isTimeoutError(err)) resetClient();
    });
    return redis;
  } catch (err) {
    log.warn({ err }, "[cache] falha ao criar redis client — fallback");
    redisDisabled = true;
    return null;
  }
}

function encode(value: unknown): string | null {
  const json = JSON.stringify(value);
  const jsonBytes = Buffer.byteLength(json, "utf8");
  if (jsonBytes < GZ_MIN_BYTES) return json;
  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 6 });
  if (gz.length >= MAX_REDIS_VALUE_BYTES) {
    return null;
  }
  return GZ_PREFIX + gz.toString("base64");
}

function decode<T>(raw: string): T {
  if (raw.startsWith(GZ_PREFIX)) {
    const json = gunzipSync(
      Buffer.from(raw.slice(GZ_PREFIX.length), "base64"),
    ).toString("utf8");
    return JSON.parse(json) as T;
  }
  return JSON.parse(raw) as T;
}

// ── Fallback in-memory ─────────────────────────────────────────────
//
// Map<key, { value, expiresAt }>. Sem LRU — limite simples por count
// pra evitar leak em dev/test. Em prod com Redis saudavel, este Map
// so e usado quando o circuit abre.

const MEMORY_MAX_ENTRIES = 1_000;
const memoryStore = new Map<string, { value: unknown; expiresAt: number }>();

function memoryGet<T>(key: string): T | undefined {
  const hit = memoryStore.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    memoryStore.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function memorySet<T>(key: string, value: T, ttlSec: number): void {
  if (memoryStore.size >= MEMORY_MAX_ENTRIES) {
    // Eviccao primitiva — apaga o primeiro inserido.
    const firstKey = memoryStore.keys().next().value;
    if (firstKey) memoryStore.delete(firstKey);
  }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

function memoryDel(key: string): void {
  memoryStore.delete(key);
}

// ── API publica ────────────────────────────────────────────────────

export type CacheKey = string;

export interface CacheOptions {
  /** TTL em segundos. Default 60s. */
  ttlSec?: number;
  /** Pular cache (forca loader). Util pra debug. */
  skipCache?: boolean;
}

/**
 * Le valor do cache. Retorna undefined se ausente / parsing falhar /
 * Redis indisponivel.
 */
export async function get<T>(key: CacheKey): Promise<T | undefined> {
  const fullKey = KEY_PREFIX + key;
  const client = getClient();
  if (!client) return memoryGet<T>(fullKey);

  try {
    const raw = await client.get(fullKey);
    noteSuccess();
    if (!raw) {
      metrics.cacheMisses?.inc({ key: safeLabel(key.split(":")[0]) });
      return undefined;
    }
    metrics.cacheHits?.inc({ key: safeLabel(key.split(":")[0]) });
    try {
      return decode<T>(raw);
    } catch (parseErr) {
      log.warn({ err: parseErr, key }, "[cache] decode falhou — tratando como miss");
      metrics.cacheMisses?.inc({ key: safeLabel(key.split(":")[0]) });
      return undefined;
    }
  } catch (err) {
    noteFailure(err, key, "get");
    return memoryGet<T>(fullKey);
  }
}

/**
 * Grava valor com TTL. Falha silenciosa.
 */
export async function set<T>(
  key: CacheKey,
  value: T,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<void> {
  const fullKey = KEY_PREFIX + key;
  const client = getClient();
  if (!client) {
    memorySet(fullKey, value, ttlSec);
    return;
  }
  const payload = encode(value);
  if (payload === null) {
    log.warn(
      { key, maxBytes: MAX_REDIS_VALUE_BYTES },
      "[cache] set pulou Redis — payload acima do limite",
    );
    memorySet(fullKey, value, ttlSec);
    return;
  }
  try {
    await client.set(fullKey, payload, "EX", ttlSec);
    noteSuccess();
  } catch (err) {
    noteFailure(err, key, "set");
    memorySet(fullKey, value, ttlSec);
  }
}

/**
 * Apaga uma chave. Aceita varias chaves de uma vez.
 */
export async function del(...keys: CacheKey[]): Promise<void> {
  if (keys.length === 0) return;
  const fullKeys = keys.map((k) => KEY_PREFIX + k);
  for (const k of fullKeys) memoryDel(k);
  const client = getClient();
  if (!client) return;
  try {
    await client.del(...fullKeys);
    noteSuccess();
  } catch (err) {
    log.warn({ err, keys }, "[cache] del falhou");
    noteFailure(err, keys[0] ?? "", "del");
  }
}

/**
 * Apaga todas as chaves matching um padrao (ex.: `channel:*`). USAR
 * COM CUIDADO — em prod com 1M+ chaves, `KEYS` trava o Redis. Aqui
 * usamos `SCAN` em batch.
 */
export async function delPattern(pattern: string): Promise<number> {
  const fullPattern = KEY_PREFIX + pattern;
  let n = 0;
  for (const k of memoryStore.keys()) {
    if (matchesGlob(k, fullPattern)) {
      memoryStore.delete(k);
      n++;
    }
  }
  const client = getClient();
  if (!client) return n;
  let cursor = "0";
  let total = n;
  try {
    do {
      const [next, batch] = await client.scan(
        cursor,
        "MATCH",
        fullPattern,
        "COUNT",
        100,
      );
      cursor = next;
      if (batch.length > 0) {
        await client.del(...batch);
        total += batch.length;
      }
    } while (cursor !== "0");
    noteSuccess();
  } catch (err) {
    log.warn({ err, pattern }, "[cache] delPattern falhou");
    noteFailure(err, pattern, "delPattern");
  }
  return total;
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Cache-aside helper. Le do cache; se ausente, chama loader, grava e
 * retorna. Inclui stampede protection — 1 loader por chave por vez
 * neste processo, e lock Redis entre replicas quando o cache esta up.
 *
 * @example
 *   const channel = await cache.wrap(`channel:${id}`, 60, () =>
 *     prismaBase.channel.findUnique({ where: { id } })
 *   );
 */
export async function wrap<T>(
  key: CacheKey,
  ttlSec: number,
  loader: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  if (options.skipCache) {
    return loader();
  }

  const cached = await get<T>(key);
  if (cached !== undefined) return cached;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = loadAndStore(key, ttlSec, loader).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

async function loadAndStore<T>(
  key: CacheKey,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  const lockKey = LOCK_PREFIX + key;
  const client = getClient();

  if (client) {
    let acquired = false;
    let lockUnavailable = false;
    try {
      const reply = await client.set(lockKey, "1", "PX", LOCK_TTL_MS, "NX");
      acquired = reply === "OK";
      noteSuccess();
    } catch (err) {
      lockUnavailable = true;
      noteFailure(err, key, "lock");
    }

    if (!acquired && !lockUnavailable) {
      // Outro replica esta carregando. Nao cair no loader: inbox counts
      // levam 4–7s e N loaders × 8 COUNTs esgotam o pool Postgres.
      for (let i = 0; i < STAMPEDE_MAX_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, STAMPEDE_RETRY_DELAY_MS));
        if (circuitIsOpen()) break;
        const retry = await get<T>(key);
        if (retry !== undefined) return retry;
        try {
          const again = await client.set(lockKey, "1", "PX", LOCK_TTL_MS, "NX");
          if (again === "OK") {
            acquired = true;
            noteSuccess();
            break;
          }
        } catch (err) {
          noteFailure(err, key, "lock");
          break;
        }
      }
      if (!acquired) {
        const late = await get<T>(key);
        if (late !== undefined) return late;
        // Nao throw: pagina 500 e pior que um loader extra neste processo
        // (singleflight ja colapsa os waiters locais).
      }
    }

    try {
      const value = await loader();
      await set(key, value, ttlSec);
      return value;
    } finally {
      if (acquired) {
        client.del(lockKey).catch(() => undefined);
      }
    }
  }

  const value = await loader();
  await set(key, value, ttlSec);
  return value;
}

function matchesGlob(input: string, pattern: string): boolean {
  // Glob simplificado: `*` -> `.*`, escapa o resto.
  const re = new RegExp(
    "^" +
      pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
  );
  return re.test(input);
}

export const cache = {
  get,
  set,
  del,
  delPattern,
  wrap,
  tryClaim,
};

/**
 * Claim atômico (SET NX). Retorna true se esta instância ganhou a chave.
 * Fallback in-memory: check-then-set (bom o bastante em single-node).
 */
export async function tryClaim(
  key: CacheKey,
  ttlSec: number,
  value: string = "1",
): Promise<boolean> {
  const fullKey = KEY_PREFIX + key;
  const client = getClient();
  if (!client) {
    if (memoryGet(fullKey) !== undefined) return false;
    memorySet(fullKey, value, ttlSec);
    return true;
  }
  try {
    const ok = await client.set(fullKey, value, "EX", ttlSec, "NX");
    noteSuccess();
    return ok === "OK";
  } catch (err) {
    noteFailure(err, key, "tryClaim");
    if (memoryGet(fullKey) !== undefined) return false;
    memorySet(fullKey, value, ttlSec);
    return true;
  }
}

export type { CacheOptions as Options };
