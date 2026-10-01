/**
 * Conexão Redis do cache (cliente único por processo) + circuit breaker.
 *
 * ## Onde o cache mora
 *
 * Por padrão o cache usa o mesmo `REDIS_URL` (mesma instância e mesmo db)
 * do BullMQ, do SSE e do rate limit. Duas envs opcionais deixam o operador
 * separar o cache sem mudar código:
 *
 * - `REDIS_CACHE_URL`: URL própria do cache (outra instância, ou a mesma
 *   com `/N` no path). Ausente → `REDIS_URL`.
 * - `REDIS_CACHE_DB`: índice do db (inteiro ≥ 0) aplicado sobre a URL
 *   escolhida acima. Ausente → o db da URL (0 se a URL não disser).
 *
 * As duas valem para TODOS os processos (API e workers): `cache.tryClaim`
 * e os números de versão só são compartilhados entre processos que
 * apontam para o mesmo db.
 *
 * ## Resiliência
 *
 * ioredis multiplexa TODOS os GETs/SETs numa conexão só. `commandTimeout`
 * conta espera na fila: um GET grande (board ~500KB) atrasava authz/
 * inbox e disparava "Command timed out" em lote. Timeout envenena o
 * pipeline do ioredis (a resposta ainda chega). Por isso: timeout mais
 * folgado, `enableOfflineQueue: false`, reconnect no timeout e circuit
 * breaker pra pular o Redis uns segundos em vez de pagar timeout em cada
 * request.
 */
import IORedis, { type Redis as IORedisClient } from "ioredis";

import { getLogger } from "@/lib/logger";
import { isRedisWritable, waitForRedisWritable } from "@/lib/redis-ready";

const log = getLogger("cache");

const CONNECT_TIMEOUT_MS = 1_000;
const COMMAND_TIMEOUT_MS = 2_000;
const CIRCUIT_FAILURES_TO_OPEN = 5;
const CIRCUIT_COOLDOWN_MS = 15_000;

let redis: IORedisClient | null = null;
let redisDisabled = false;
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lastCircuitLogAt = 0;

export type CacheRedisTarget = {
  /** URL passada ao ioredis (já com o db no path quando dá pra reescrever). */
  url: string;
  /** Db pedido em `REDIS_CACHE_DB`; `null` = o da URL. */
  db: number | null;
  source: "REDIS_CACHE_URL" | "REDIS_URL";
};

function parseCacheDb(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) {
    log.warn(
      { value: text },
      "[cache] REDIS_CACHE_DB inválido (esperado inteiro ≥ 0) — ignorado",
    );
    return null;
  }
  return Number(text);
}

/**
 * Troca o db no path da URL. O ioredis dá precedência ao db da URL sobre
 * `options.db`, então a troca precisa ser no texto. Devolve `null` quando
 * a string não é `redis://` / `rediss://` (aí o db vai por opção).
 */
function withDbInUrl(url: string, db: number): string | null {
  const match = /^(rediss?:\/\/[^/?#]+)(?:\/[^?#]*)?(.*)$/i.exec(url);
  if (!match) return null;
  return `${match[1]}/${db}${match[2] ?? ""}`;
}

/**
 * Para onde o cache conecta, a partir das envs. `null` = sem Redis
 * (fallback em memória). Sem `REDIS_CACHE_URL` nem `REDIS_CACHE_DB`, é
 * exatamente o `REDIS_URL`.
 */
export function resolveCacheRedisTarget(
  env: Record<string, string | undefined> = process.env,
): CacheRedisTarget | null {
  const cacheUrl = env.REDIS_CACHE_URL?.trim();
  const baseUrl = cacheUrl || env.REDIS_URL;
  if (!baseUrl) return null;
  const source = cacheUrl ? "REDIS_CACHE_URL" : "REDIS_URL";
  const db = parseCacheDb(env.REDIS_CACHE_DB);
  if (db === null) return { url: baseUrl, db: null, source };
  return { url: withDbInUrl(baseUrl, db) ?? baseUrl, db, source };
}

export function circuitIsOpen(): boolean {
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

export function noteSuccess(): void {
  consecutiveFailures = 0;
}

export function noteFailure(err: unknown, key: string, op: string): void {
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

function ensureClient(): IORedisClient | null {
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
  const target = resolveCacheRedisTarget();
  if (!target) {
    redisDisabled = true;
    log.info("[cache] REDIS_URL ausente — usando fallback in-memory.");
    return null;
  }
  try {
    redis = new IORedis(target.url, {
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
      // Só entra quando o operador pediu um db. A URL reescrita já carrega
      // o mesmo número; isto cobre URL fora do formato redis(s)://.
      ...(target.db !== null ? { db: target.db } : {}),
      retryStrategy(times) {
        if (circuitIsOpen()) return null;
        return Math.min(times * 200, 2_000);
      },
    });
    if (target.source !== "REDIS_URL" || target.db !== null) {
      // Nunca logar a URL: ela carrega a senha.
      log.info(
        { source: target.source, db: target.db },
        "[cache] Redis do cache em conexão própria",
      );
    }
    redis.on("error", (err) => {
      if (Date.now() - lastCircuitLogAt > 5_000) {
        lastCircuitLogAt = Date.now();
        log.warn({ err }, "[cache] redis client error (continuando com fallback)");
      }
      if (isTimeoutError(err)) resetClient();
    });
    return redis;
  } catch (err) {
    log.warn({ err }, "[cache] falha ao criar redis client — fallback");
    redisDisabled = true;
    return null;
  }
}

/**
 * Cliente só quando o socket já aceita comando. Com
 * `enableOfflineQueue: false`, GET/SET em `connecting` vira
 * "Stream isn't writeable" e o circuit abre no boot do worker.
 */
export function getCacheClient(): IORedisClient | null {
  const client = ensureClient();
  if (!client) return null;
  if (!isRedisWritable(client)) return null;
  return client;
}

/** Sem URL de Redis (ou cliente que não pôde ser criado): só memória. */
export function isCacheRedisDisabled(): boolean {
  return redisDisabled;
}

/** Workers: espera o Redis do cache ficar ready antes do 1º job. */
export async function waitUntilCacheReady(
  timeoutMs = 8_000,
): Promise<boolean> {
  const client = ensureClient();
  if (!client) return false;
  return waitForRedisWritable(client, timeoutMs);
}
