/**
 * Limite por usuário e por CLASSE DE CUSTO da rota (`api-cost-class.ts`).
 * Substitui o perfil antigo `api.session` (600 pontos / 60 s por usuário),
 * que ao estourar bloqueava o usuário INTEIRO até a janela virar — o app
 * quebrava para ele (enviar mensagem incluído) e o servidor não ganhava nada.
 *
 * Regras
 * ──────
 * - `essential` (enviar mensagem, anexos, mover negócio, salvar, auth): sem
 *   limite, nunca 429/503.
 * - `cached_read`, `heavy_read`, `accessory`: um token bucket por usuário e
 *   classe, com refill CONTÍNUO (não há janela fixa nem bloqueio). Estourou
 *   uma classe → 429 curto só nela; as outras seguem livres.
 * - Resposta: 429 `{ message, code: "RATE_LIMITED", class, retryAfterMs }`,
 *   `retryAfterMs` entre 2.000 e 5.000, header `Retry-After` (segundos).
 *
 * Armazenamento
 * ─────────────
 * Redis do cache (`getCacheClient`): um hash por usuário+classe
 * (`rl:cost:<classe>:<userId>` → `t` tokens, `ts` último refill), atualizado
 * num script Lua (atômico entre réplicas), com TTL = tempo para encher.
 * Sem Redis configurado → bucket em memória do processo. Redis configurado
 * mas fora do ar / com erro → FAIL-OPEN (deixa passar): o limite é rede de
 * proteção, não pode virar indisponibilidade.
 *
 * Log de rejeição: `api_cost_rejected` com userId, classe e rota, no máximo
 * 1 por usuário+classe por minuto (por processo, e entre réplicas via
 * `SET NX` no Redis), com a contagem do que foi suprimido.
 *
 * Envs (todas opcionais; ver `.env.example`):
 * - `API_COST_LIMIT_DISABLED=1` desliga os 429 desta camada.
 * - `API_COST_CACHED_READ_PER_MIN` (1200) — capacidade e taxa por minuto da
 *   classe (b). Alias antigo: `SESSION_RATE_LIMIT_RPM`.
 * - `API_COST_HEAVY_CAPACITY` (60) e `API_COST_HEAVY_REFILL_PER_SEC` (2).
 * - `API_COST_ACCESSORY_CAPACITY` (30) e `API_COST_ACCESSORY_REFILL_PER_SEC` (1).
 */
import { NextResponse } from "next/server";

import type { ApiCostClass } from "@/lib/api-cost-class";
import { getCacheClient, isCacheRedisDisabled, noteFailure, noteSuccess } from "@/lib/cache/redis-client";
import { getLogger } from "@/lib/logger";
import { metrics, templatizeRoute } from "@/lib/metrics";

const log = getLogger("api-cost-limit");

export const API_COST_RETRY_MIN_MS = 2_000;
export const API_COST_RETRY_MAX_MS = 5_000;

export const DEFAULT_CACHED_READ_PER_MIN = 1_200;
export const DEFAULT_HEAVY_CAPACITY = 60;
export const DEFAULT_HEAVY_REFILL_PER_SEC = 2;
export const DEFAULT_ACCESSORY_CAPACITY = 30;
export const DEFAULT_ACCESSORY_REFILL_PER_SEC = 1;

export type TokenBucketConfig = { capacity: number; refillPerSec: number };
type Env = Record<string, string | undefined>;

function positive(raw: string | undefined): number | null {
  const v = raw?.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isApiCostLimitDisabled(env: Env = process.env): boolean {
  const v = env.API_COST_LIMIT_DISABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Configuração do bucket da classe; `null` = classe sem limite. */
export function getApiCostBucketConfig(
  cls: ApiCostClass,
  env: Env = process.env,
): TokenBucketConfig | null {
  switch (cls) {
    case "essential":
      return null;
    case "cached_read": {
      const perMin =
        positive(env.API_COST_CACHED_READ_PER_MIN) ??
        positive(env.SESSION_RATE_LIMIT_RPM) ??
        DEFAULT_CACHED_READ_PER_MIN;
      return { capacity: Math.floor(perMin), refillPerSec: perMin / 60 };
    }
    case "heavy_read":
      return {
        capacity: Math.floor(positive(env.API_COST_HEAVY_CAPACITY) ?? DEFAULT_HEAVY_CAPACITY),
        refillPerSec: positive(env.API_COST_HEAVY_REFILL_PER_SEC) ?? DEFAULT_HEAVY_REFILL_PER_SEC,
      };
    case "accessory":
      return {
        capacity: Math.floor(positive(env.API_COST_ACCESSORY_CAPACITY) ?? DEFAULT_ACCESSORY_CAPACITY),
        refillPerSec:
          positive(env.API_COST_ACCESSORY_REFILL_PER_SEC) ?? DEFAULT_ACCESSORY_REFILL_PER_SEC,
      };
  }
}

/** Espera sugerida ao cliente: sempre entre 2 e 5 s. */
export function clampRetryAfterMs(waitMs: number): number {
  if (!Number.isFinite(waitMs)) return API_COST_RETRY_MAX_MS;
  return Math.min(API_COST_RETRY_MAX_MS, Math.max(API_COST_RETRY_MIN_MS, Math.ceil(waitMs)));
}

// ── Token bucket ─────────────────────────────────────────────────────────

export type TokenBucketDecision = {
  allowed: boolean;
  /** Tokens que sobraram (aprox.). */
  remaining: number;
  /** Quanto falta (ms) para caber o pedido; 0 quando permitido. */
  waitMs: number;
  /** `redis` | `memory` | `fail-open`. */
  store: "redis" | "memory" | "fail-open";
};

/**
 * Refill contínuo: tokens = min(cap, tokens + (agora - ts) × taxa). Cabe →
 * consome; não cabe → devolve a espera. TTL = tempo para encher + 1 s (a
 * chave ociosa some sozinha; recriada cheia, que é o mesmo estado).
 */
const TOKEN_BUCKET_SCRIPT = `-- crm:api-cost-token-bucket
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local d = redis.call("HMGET", KEYS[1], "t", "ts")
local tokens = tonumber(d[1])
local ts = tonumber(d[2])
if tokens == nil or ts == nil then
  tokens = cap
  ts = now
end
if now > ts then
  tokens = math.min(cap, tokens + (now - ts) * rate)
  ts = now
end
local allowed = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) / rate)
end
redis.call("HSET", KEYS[1], "t", tostring(tokens), "ts", tostring(ts))
redis.call("PEXPIRE", KEYS[1], math.ceil(cap / rate) + 1000)
return {allowed, wait, math.floor(tokens)}`;

type MemoryBucket = { tokens: number; ts: number };
const MEMORY_MAX_KEYS = 10_000;

type State = {
  memory: Map<string, MemoryBucket>;
  /** Só testes: cliente Redis falso (`undefined` = o do cache). */
  redisOverride: unknown;
  now: () => number;
  /** usuário+classe → { último log, suprimidos desde então }. */
  logSamples: Map<string, { at: number; suppressed: number }>;
  emit: ((obj: Record<string, unknown>, msg: string) => void) | null;
  /** Objetos `Headers` de requisições já cobradas (requireAuth chamado 2×). */
  charged: WeakSet<object>;
};

const globalForCost = globalThis as typeof globalThis & { __crmApiCostLimit?: State };

function state(): State {
  if (!globalForCost.__crmApiCostLimit) {
    globalForCost.__crmApiCostLimit = {
      memory: new Map(),
      redisOverride: undefined,
      now: () => Date.now(),
      logSamples: new Map(),
      emit: null,
      charged: new WeakSet(),
    };
  }
  return globalForCost.__crmApiCostLimit;
}

type RedisLike = {
  eval: (...args: Array<string | number>) => Promise<unknown>;
  set: (...args: Array<string | number>) => Promise<unknown>;
};

/** `{client}` = usar Redis; `{memory}` = sem Redis configurado; `{failOpen}` = Redis fora. */
function resolveStore(): { client: RedisLike } | { memory: true } | { failOpen: true } {
  const s = state();
  if (s.redisOverride !== undefined) {
    return s.redisOverride ? { client: s.redisOverride as RedisLike } : { memory: true };
  }
  if (process.env.VITEST === "true") return { memory: true };
  const client = getCacheClient();
  if (client) return { client: client as unknown as RedisLike };
  return isCacheRedisDisabled() ? { memory: true } : { failOpen: true };
}

function consumeMemory(key: string, cfg: TokenBucketConfig, now: number, cost: number): TokenBucketDecision {
  const s = state();
  let b = s.memory.get(key);
  if (!b) {
    if (s.memory.size >= MEMORY_MAX_KEYS) {
      // Descarta a mais antiga inserida (Map preserva a ordem). Bucket
      // esquecido volta cheio — no pior caso libera um pouco mais.
      const oldest = s.memory.keys().next().value;
      if (oldest !== undefined) s.memory.delete(oldest);
    }
    b = { tokens: cfg.capacity, ts: now };
    s.memory.set(key, b);
  }
  if (now > b.ts) {
    b.tokens = Math.min(cfg.capacity, b.tokens + ((now - b.ts) / 1000) * cfg.refillPerSec);
    b.ts = now;
  }
  if (b.tokens >= cost) {
    b.tokens -= cost;
    return { allowed: true, remaining: Math.floor(b.tokens), waitMs: 0, store: "memory" };
  }
  const waitMs = Math.ceil(((cost - b.tokens) / cfg.refillPerSec) * 1000);
  return { allowed: false, remaining: 0, waitMs, store: "memory" };
}

export function apiCostBucketKey(cls: ApiCostClass, userId: string): string {
  return `rl:cost:${cls}:${userId}`;
}

/** Consome `cost` tokens do bucket do usuário na classe. Nunca lança. */
export async function consumeApiCostToken(args: {
  cls: ApiCostClass;
  userId: string;
  config: TokenBucketConfig;
  cost?: number;
}): Promise<TokenBucketDecision> {
  const cost = args.cost ?? 1;
  const key = apiCostBucketKey(args.cls, args.userId);
  const now = state().now();
  const store = resolveStore();
  if ("memory" in store) return consumeMemory(key, args.config, now, cost);
  if ("failOpen" in store) {
    return { allowed: true, remaining: args.config.capacity, waitMs: 0, store: "fail-open" };
  }
  try {
    const raw = await store.client.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      key,
      String(args.config.capacity),
      // tokens por ms
      String(args.config.refillPerSec / 1000),
      String(now),
      String(cost),
    );
    noteSuccess();
    const [allowed, wait, remaining] = Array.isArray(raw) ? raw.map(Number) : [1, 0, 0];
    return {
      allowed: allowed === 1,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      waitMs: allowed === 1 ? 0 : Number.isFinite(wait) ? wait : API_COST_RETRY_MAX_MS,
      store: "redis",
    };
  } catch (err) {
    noteFailure(err, key, "api-cost-limit");
    return { allowed: true, remaining: args.config.capacity, waitMs: 0, store: "fail-open" };
  }
}

// ── Log de rejeição amostrado ────────────────────────────────────────────

export const API_COST_REJECT_LOG_INTERVAL_MS = 60_000;
const LOG_SAMPLE_MAX_KEYS = 5_000;

export type ApiCostRejectInfo = {
  userId: string;
  organizationId?: string | null;
  cls: ApiCostClass;
  method?: string | null;
  path?: string | null;
  status: 429 | 503;
  retryAfterMs: number;
  reason: "rate_limit" | "overload";
};

/**
 * No máximo 1 linha por usuário+classe por minuto. A 1ª rejeição loga na
 * hora; as seguintes só contam e saem como `suppressed` na próxima linha.
 */
export function logApiCostReject(info: ApiCostRejectInfo): void {
  const s = state();
  const now = s.now();
  const sampleKey = `${info.userId}:${info.cls}`;
  const prev = s.logSamples.get(sampleKey);
  if (prev && now - prev.at < API_COST_REJECT_LOG_INTERVAL_MS) {
    prev.suppressed += 1;
    return;
  }
  if (!prev && s.logSamples.size >= LOG_SAMPLE_MAX_KEYS) {
    const oldest = s.logSamples.keys().next().value;
    if (oldest !== undefined) s.logSamples.delete(oldest);
  }
  const suppressed = prev?.suppressed ?? 0;
  s.logSamples.delete(sampleKey);
  s.logSamples.set(sampleKey, { at: now, suppressed: 0 });

  const payload = {
    event: "api_cost_rejected",
    userId: info.userId,
    organizationId: info.organizationId ?? undefined,
    class: info.cls,
    route: info.path ? templatizeRoute(info.path) : undefined,
    method: info.method ?? undefined,
    status: info.status,
    reason: info.reason,
    retryAfterMs: info.retryAfterMs,
    suppressed,
  };
  const emit = s.emit ?? ((obj: Record<string, unknown>, msg: string) => log.warn(obj, msg));
  const store = resolveStore();
  if (!("client" in store)) {
    emit(payload, "requisição recusada pela classe de custo");
    return;
  }
  // Entre réplicas: só quem ganhar o SET NX do minuto loga.
  const windowId = Math.floor(now / API_COST_REJECT_LOG_INTERVAL_MS);
  void store.client
    .set(`rl:cost:log:${sampleKey}:${windowId}`, "1", "EX", 65, "NX")
    .then((ok) => {
      if (ok === "OK") emit(payload, "requisição recusada pela classe de custo");
    })
    .catch(() => emit(payload, "requisição recusada pela classe de custo"));
}

// ── Respostas ────────────────────────────────────────────────────────────

export type ApiCostRejectBody = {
  message: string;
  code: "RATE_LIMITED" | "OVERLOADED";
  class: ApiCostClass;
  retryAfterMs: number;
};

export function apiCostRejectResponse(
  status: 429 | 503,
  cls: ApiCostClass,
  retryAfterMs: number,
): NextResponse<ApiCostRejectBody> {
  const ms = clampRetryAfterMs(retryAfterMs);
  const body: ApiCostRejectBody =
    status === 429
      ? {
          message: "Muitas requisições deste tipo. Tente novamente em instantes.",
          code: "RATE_LIMITED",
          class: cls,
          retryAfterMs: ms,
        }
      : {
          message: "Servidor ocupado. Tente novamente em instantes.",
          code: "OVERLOADED",
          class: cls,
          retryAfterMs: ms,
        };
  return NextResponse.json(body, {
    status,
    headers: {
      "Retry-After": String(Math.ceil(ms / 1000)),
      "Cache-Control": "no-store",
    },
  });
}

// ── Ponto único chamado pela autenticação ────────────────────────────────

export type EnforceApiCostArgs = {
  userId: string;
  organizationId?: string | null;
  cls: ApiCostClass;
  method?: string | null;
  path?: string | null;
  /**
   * Objeto da requisição (ex.: `Headers` do `headers()`). Se o mesmo objeto
   * passar 2× (`requireRole` → `requireAuth` e o handler de novo), cobra 1×.
   */
  requestToken?: object | null;
};

/** 429 da classe ou `null` (segue). Nunca bloqueia `essential`. */
export async function enforceApiCostLimits(args: EnforceApiCostArgs): Promise<NextResponse | null> {
  const userId = args.userId?.trim();
  if (!userId || args.cls === "essential") return null;
  if (isApiCostLimitDisabled()) return null;
  const config = getApiCostBucketConfig(args.cls);
  if (!config) return null;

  const s = state();
  if (args.requestToken) {
    if (s.charged.has(args.requestToken)) return null;
    s.charged.add(args.requestToken);
  }

  const decision = await consumeApiCostToken({ cls: args.cls, userId, config });
  if (decision.allowed) return null;

  const retryAfterMs = clampRetryAfterMs(decision.waitMs);
  try {
    metrics.apiCost.rejections.inc({ class: args.cls, status: "429" });
  } catch {
    /* métrica nunca derruba a requisição */
  }
  logApiCostReject({
    userId,
    organizationId: args.organizationId,
    cls: args.cls,
    method: args.method,
    path: args.path,
    status: 429,
    retryAfterMs,
    reason: "rate_limit",
  });
  return apiCostRejectResponse(429, args.cls, retryAfterMs);
}

/** Só testes. */
export function resetApiCostLimitForTests(opts?: {
  redis?: unknown;
  now?: () => number;
  emit?: ((obj: Record<string, unknown>, msg: string) => void) | null;
}): void {
  globalForCost.__crmApiCostLimit = undefined;
  const s = state();
  if (opts && "redis" in opts) s.redisOverride = opts.redis ?? null;
  if (opts?.now) s.now = opts.now;
  if (opts?.emit !== undefined) s.emit = opts.emit;
}
