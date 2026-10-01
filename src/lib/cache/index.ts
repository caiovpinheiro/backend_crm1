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
 * A conexao (timeouts, circuit breaker, db proprio via `REDIS_CACHE_URL`
 * / `REDIS_CACHE_DB`) mora em `redis-client.ts`. Aqui: gzip em payload
 * grande e fallback em memoria quando o Redis nao responde.
 */
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

import { getLogger } from "@/lib/logger";
import { metrics, safeLabel } from "@/lib/metrics";

import {
  circuitIsOpen,
  getCacheClient as getClient,
  noteFailure,
  noteSuccess,
  waitUntilCacheReady,
} from "./redis-client";

export { waitUntilCacheReady };

const log = getLogger("cache");

const KEY_PREFIX = "cache:";
const LOCK_PREFIX = "cache-lock:";
const DEFAULT_TTL_SEC = 60;
const LOCK_TTL_MS = 20_000;
const STAMPEDE_RETRY_DELAY_MS = 150;
const STAMPEDE_MAX_RETRIES = 50;

/** Prefixos ASCII que JSON.parse nunca aceita — valores gzipados. */
const GZ_PREFIX = "gz1:";
const GZ_MIN_BYTES = 8_192;
/**
 * Teto do valor gzipado (antes do base64). Com 256 KB o board das orgs
 * grandes nunca ia pro Redis e cada carga recalculava tudo. Acima disso
 * o valor fica só no fallback em memória do processo.
 */
const MAX_REDIS_VALUE_BYTES = 1_000_000;

/** gzip no threadpool do libuv — `gzipSync` travava a thread principal. */
const gzipAsync = promisify(gzip);
/**
 * gunzip também no threadpool: o board chega a 1 MB gzipado (vários MB de
 * JSON) e o `get` roda em cada carga — `gunzipSync` segurava a thread
 * principal a cada hit, mais vezes que o `set`.
 */
const gunzipAsync = promisify(gunzip);

/**
 * Libera o lock SÓ se o valor ainda é o token desta chamada
 * (compare-and-delete atômico). Retorna 1 se apagou, 0 caso contrário.
 */
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

async function encode(value: unknown): Promise<string | null> {
  const json = JSON.stringify(value);
  const jsonBytes = Buffer.byteLength(json, "utf8");
  if (jsonBytes < GZ_MIN_BYTES) return json;
  const gz = await gzipAsync(Buffer.from(json, "utf8"), { level: 6 });
  if (gz.length >= MAX_REDIS_VALUE_BYTES) {
    return null;
  }
  return GZ_PREFIX + gz.toString("base64");
}

async function decode<T>(raw: string): Promise<T> {
  if (raw.startsWith(GZ_PREFIX)) {
    const json = (
      await gunzipAsync(Buffer.from(raw.slice(GZ_PREFIX.length), "base64"))
    ).toString("utf8");
    return JSON.parse(json) as T;
  }
  return JSON.parse(raw) as T;
}

// ── Fallback in-memory ─────────────────────────────────────────────
//
// Map<key, { value, expiresAt }>. Sem LRU — limite simples por count
// pra evitar leak em dev/test. Em prod com Redis saudavel, este Map
// guarda o que o Redis não levou (payload acima do teto ou SET que
// falhou) e é lido quando o Redis não tem a chave ou o circuit abre.
// Vale por processo: um `del` feito em outro processo não limpa este Map,
// e o TTL é o limite do stale. Família com versão (ver `versions.ts`) segue
// a mesma regra aqui: a versão vai na chave, então o valor antigo deixa de
// ser lido assim que este processo enxerga a versão nova.

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

export interface CacheOptions<T = unknown> {
  /** TTL em segundos. Default 60s. */
  ttlSec?: number;
  /** Pular cache (forca loader). Util pra debug. */
  skipCache?: boolean;
  /**
   * O valor em cache só vale se passar aqui; recusado conta como miss e o
   * loader roda de novo. Para valores que carregam o próprio carimbo de
   * validade (versão conferida depois da leitura).
   */
  accept?: (value: T) => boolean | Promise<boolean>;
}

type Accept<T> = CacheOptions<T>["accept"];

/** `get` que trata valor recusado por `accept` como miss. */
async function getAccepted<T>(
  key: CacheKey,
  accept: Accept<T>,
): Promise<T | undefined> {
  const value = await get<T>(key);
  if (value === undefined || !accept) return value;
  try {
    return (await accept(value)) ? value : undefined;
  } catch {
    return undefined;
  }
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
      // O `set` guarda aqui o que não coube no Redis (board grande).
      const local = memoryGet<T>(fullKey);
      if (local !== undefined) {
        metrics.cacheHits?.inc({ key: safeLabel(key.split(":")[0]) });
        return local;
      }
      metrics.cacheMisses?.inc({ key: safeLabel(key.split(":")[0]) });
      return undefined;
    }
    metrics.cacheHits?.inc({ key: safeLabel(key.split(":")[0]) });
    try {
      return await decode<T>(raw);
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
  const payload = await encode(value);
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
    // Cópia local antiga não pode responder quando esta chave sair do Redis.
    memoryDel(fullKey);
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
 * Apaga todas as chaves matching um padrao (ex.: `channel:*`).
 *
 * SÓ PARA USO ADMINISTRATIVO (script, manutenção). O `SCAN` percorre o
 * keyspace inteiro do db — o custo é o total de chaves, não as que casam —
 * e o `MATCH` é sempre restrito ao prefixo do cache (`cache:<padrao>`).
 * Nenhum caminho da aplicação chama isto: invalidação de família é por
 * versão (`bumpCacheVersion`, um INCR — ver `versions.ts` e `keys.ts`).
 * Não inclui as versões (`cache:v:*`) de propósito: apagar uma versão
 * equivale a invalidar a família, use o bump.
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
        1000,
      );
      cursor = next;
      if (batch.length > 0) {
        // UNLINK é assíncrono (não bloqueia o event loop do Redis em
        // batches grandes, ao contrário do DEL síncrono).
        await client.unlink(...batch);
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
  options: CacheOptions<T> = {},
): Promise<T> {
  if (options.skipCache) {
    return loader();
  }

  const cached = await getAccepted<T>(key, options.accept);
  if (cached !== undefined) return cached;

  return loadShared(key, ttlSec, loader, options.accept);
}

/** Miss: um loader por chave neste processo (singleflight) + lock Redis. */
function loadShared<T>(
  key: CacheKey,
  ttlSec: number,
  loader: () => Promise<T>,
  accept: Accept<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = loadAndStore(key, ttlSec, loader, accept).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

async function loadAndStore<T>(
  key: CacheKey,
  ttlSec: number,
  loader: () => Promise<T>,
  accept: Accept<T>,
): Promise<T> {
  const lockKey = LOCK_PREFIX + key;
  const client = getClient();

  if (client) {
    // Token único por chamada: o release só apaga o lock se ele ainda
    // for NOSSO (compare-and-delete via Lua). Sem isso, um loader lento
    // (> LOCK_TTL_MS) tinha o lock expirado, outro request adquiria, e o
    // primeiro liberava o lock do segundo — dois loaders concorrentes.
    const lockToken = newLockToken();
    let acquired = false;
    let lockUnavailable = false;
    try {
      const reply = await client.set(lockKey, lockToken, "PX", LOCK_TTL_MS, "NX");
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
        const retry = await getAccepted<T>(key, accept);
        if (retry !== undefined) return retry;
        try {
          const again = await client.set(lockKey, lockToken, "PX", LOCK_TTL_MS, "NX");
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
        const late = await getAccepted<T>(key, accept);
        if (late !== undefined) return late;
        // Degrada em vez de estourar 500: chama o loader direto (sem
        // lock). Pior caso = alguns loaders concorrentes pontuais, que é
        // exatamente o cenário que o lock evita no hot path — aceitável
        // como fallback, inaceitável como resposta de erro ao usuário.
        log.warn({ key }, "[cache] stampede timeout — degradando para loader direto");
        const value = await loader();
        await set(key, value, ttlSec);
        return value;
      }
    }

    try {
      const value = await loader();
      await set(key, value, ttlSec);
      return value;
    } finally {
      if (acquired) {
        client
          .eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken)
          .catch(() => undefined);
      }
    }
  }

  const value = await loader();
  await set(key, value, ttlSec);
  return value;
}

function newLockToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

// ── Stale-while-revalidate ─────────────────────────────────────────
//
// `wrap` bloqueia a requisição que chega depois do TTL até o loader
// terminar. Para leituras caras em que um número um pouco velho é aceito
// (contadores das abas do inbox), `wrapSwr` devolve o valor vencido na
// hora e recalcula em segundo plano:
//
//   idade < ttlSec                → fresco, devolve.
//   ttlSec ≤ idade < ttl + stale  → devolve o vencido e dispara UMA
//                                   revalidação por chave (singleflight no
//                                   processo + lock Redis entre réplicas).
//   ausente ou idade ≥ ttl+stale  → bloqueia e recalcula, como o `wrap`.
//
// Teto de staleness = ttlSec + staleSec: é o TTL da chave no Redis (e no
// fallback em memória), então valor mais velho que isso nem existe mais.
// O valor é guardado num envelope `{ swr: 1, at, v }` — não ler a mesma
// chave com `get`/`wrap` (use `peekSwr`).

export interface SwrOptions {
  /** Segundos em que o valor é servido como fresco. */
  ttlSec: number;
  /** Segundos a mais em que o vencido ainda é servido enquanto revalida. */
  staleSec: number;
}

type SwrEnvelope<T> = { swr: 1; at: number; v: T };

function isSwrEnvelope<T>(value: unknown): value is SwrEnvelope<T> {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return rec.swr === 1 && typeof rec.at === "number" && "v" in rec;
}

/** Depois de revalidação que falhou: não tentar de novo antes disso. */
const SWR_FAILURE_BACKOFF_MS = 5_000;
/** Outra réplica está com o lock: não disputar de novo antes disso. */
const SWR_LOCK_BUSY_BACKOFF_MS = 1_000;

const swrRevalidating = new Map<string, Promise<void>>();
const swrRetryAfter = new Map<string, number>();

function swrBackoff(key: CacheKey, ms: number): void {
  if (!swrRetryAfter.has(key) && swrRetryAfter.size >= MEMORY_MAX_ENTRIES) {
    const oldest = swrRetryAfter.keys().next().value;
    if (oldest !== undefined) swrRetryAfter.delete(oldest);
  }
  swrRetryAfter.set(key, Date.now() + ms);
}

/**
 * Cache-aside com stale-while-revalidate. Mesma assinatura de `wrap`, com
 * `{ ttlSec, staleSec }` no lugar do TTL.
 */
export async function wrapSwr<T>(
  key: CacheKey,
  options: SwrOptions,
  loader: () => Promise<T>,
): Promise<T> {
  const freshMs = options.ttlSec * 1000;
  const hardTtlSec = options.ttlSec + options.staleSec;
  const load = async (): Promise<SwrEnvelope<T>> => {
    const v = await loader();
    return { swr: 1, at: Date.now(), v };
  };

  const cached = await get<SwrEnvelope<T>>(key);
  if (isSwrEnvelope<T>(cached)) {
    const age = Date.now() - cached.at;
    if (age < freshMs) return cached.v;
    if (age < hardTtlSec * 1000) {
      revalidateInBackground(key, hardTtlSec, load);
      return cached.v;
    }
  }

  const stored = await loadShared<SwrEnvelope<T>>(
    key,
    hardTtlSec,
    load,
    // Enquanto espera o lock de outra réplica, só serve o que ela gravou.
    (value) => isSwrEnvelope<T>(value) && Date.now() - value.at < freshMs,
  );
  return stored.v;
}

/** Lê o valor de uma chave `wrapSwr` (fresco ou vencido) sem recalcular. */
export async function peekSwr<T>(key: CacheKey): Promise<T | undefined> {
  const cached = await get<SwrEnvelope<T>>(key);
  return isSwrEnvelope<T>(cached) ? cached.v : undefined;
}

/** Fire-and-forget: nunca lança nem segura quem chamou. */
function revalidateInBackground<T>(
  key: CacheKey,
  hardTtlSec: number,
  load: () => Promise<SwrEnvelope<T>>,
): void {
  if (swrRevalidating.has(key)) return;
  const retryAfter = swrRetryAfter.get(key);
  if (retryAfter !== undefined) {
    if (Date.now() < retryAfter) return;
    swrRetryAfter.delete(key);
  }
  const run = revalidate(key, hardTtlSec, load)
    .catch((err) => {
      // O valor vencido continua sendo servido até o teto.
      log.warn({ err, key }, "[cache] revalidação em segundo plano falhou");
      swrBackoff(key, SWR_FAILURE_BACKOFF_MS);
    })
    .finally(() => {
      swrRevalidating.delete(key);
    });
  swrRevalidating.set(key, run);
}

async function revalidate<T>(
  key: CacheKey,
  hardTtlSec: number,
  load: () => Promise<SwrEnvelope<T>>,
): Promise<void> {
  const lockKey = LOCK_PREFIX + key;
  const lockToken = newLockToken();
  const client = getClient();
  let acquired = false;
  if (client) {
    try {
      const reply = await client.set(lockKey, lockToken, "PX", LOCK_TTL_MS, "NX");
      noteSuccess();
      acquired = reply === "OK";
      if (!acquired) {
        // Outra réplica já está recalculando esta chave.
        swrBackoff(key, SWR_LOCK_BUSY_BACKOFF_MS);
        return;
      }
    } catch (err) {
      // Sem lock: o singleflight deste processo basta.
      noteFailure(err, key, "lock");
    }
  }
  try {
    await set(key, await load(), hardTtlSec);
  } finally {
    if (acquired && client) {
      client
        .eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken)
        .catch(() => undefined);
    }
  }
}

function matchesGlob(input: string, pattern: string): boolean {
  // Glob simplificado (mesma semântica do MATCH do Redis): `*` -> `.*`,
  // `?` -> um caractere, escapa o resto.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
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
  wrapSwr,
  peekSwr,
  tryClaim,
  waitUntilReady: waitUntilCacheReady,
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
