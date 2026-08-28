/**
 * Rate-limit por organização / IP / usuário (PR 2.3).
 *
 * Backend
 * ───────
 * - **Self-host MVP**: `rate-limiter-flexible` com `RateLimiterRedis` apontando
 *   pro mesmo Redis usado por BullMQ/sseBus. Sliding-window com TTL por chave;
 *   atomicidade via Lua script da própria lib.
 * - **Fallback in-memory**: se `REDIS_URL` ausente, cai pra `RateLimiterMemory`
 *   (1 réplica, sem replicação). Garante que `next dev` local não exija Redis.
 * - **SaaS futuro (Upstash)**: a interface pública (`consumeRateLimit`,
 *   `withRateLimit`) é suficientemente abstrata para trocar pra
 *   `@upstash/ratelimit` sem mexer em call-sites — só recompilando este
 *   arquivo. Documentado em docs/rate-limit.md.
 *
 * Convenções de chave
 * ───────────────────
 * Toda chave é prefixada com `rl:` + scope para inspeção fácil no Redis CLI:
 *   - `rl:org:<organizationId>:<route>`
 *   - `rl:user:<userId>:<route>`
 *   - `rl:ip:<ip>:<route>`
 *   - `rl:api.session:session:<userId>` (cookie NextAuth — requireAuth)
 *   - `rl:api.token:token:<hash>` (Bearer)
 *
 * Nunca misturar IP e org na mesma chave — quem dispara abuso pode trocar
 * de IP, mas a organização não muda. O critério "pior ofensor primeiro" é
 * o `org` quando autenticado, `ip` em rotas públicas (login, signup).
 *
 * Multi-tier: o handler decide qual perfil usar (login=ip-strict,
 * api-padrão=org-default, AI tools=org-strict). Os perfis ficam centralizados
 * em `RATE_LIMIT_PROFILES` pra evitar mágica espalhada.
 */

import { NextResponse } from "next/server";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type IRateLimiterStoreOptions,
  type RateLimiterAbstract,
  type RateLimiterRes,
} from "rate-limiter-flexible";

import { getLogger } from "@/lib/logger";
import { metrics, safeLabel } from "@/lib/metrics";
import { getOrgRateLimitRpm } from "@/lib/org-rate-limit-config";
import { logRateLimitReject } from "@/lib/rate-limit-reject-log";

const log = getLogger("rate-limit");

/** Default do perfil `api.session`. Override: `SESSION_RATE_LIMIT_RPM`. */
export const DEFAULT_SESSION_RATE_LIMIT_RPM = 600;

export function getSessionRateLimitRpm(): number {
  const raw = process.env.SESSION_RATE_LIMIT_RPM?.trim();
  if (!raw) return DEFAULT_SESSION_RATE_LIMIT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SESSION_RATE_LIMIT_RPM;
  return Math.floor(n);
}

export function sessionRateLimitKey(userId: string): string {
  return `session:${userId}`;
}

/**
 * Perfis canônicos. Todo handler escolhe um destes — não inventar limites
 * ad-hoc na rota. Mudanças aqui se aplicam em massa.
 *
 * Os números são ponto de partida razoável pra um SaaS B2B em MVP; quando
 * tivermos métricas de tráfego real (Prom + grafana de PR 2.2), revisar
 * com base no p95 observado.
 */
export const RATE_LIMIT_PROFILES = {
  /** Endpoints quentes do CRM (mensagens, search, kanban). Teto por rota = ORG_RATE_LIMIT_RPM. */
  "api.default": { points: getOrgRateLimitRpm(), durationSec: 60 },
  /** AI tools (geração de copy, drafts). LLMs custam $$ — 60 req/min/org. */
  "api.ai": { points: 60, durationSec: 60 },
  /** Webhooks do CRM (in vez de Meta). 120/min/org. */
  "api.webhooks": { points: 120, durationSec: 60 },
  /** Endpoints públicos sensíveis: login, signup, recover-password. 10 req/min/IP. */
  "auth.public": { points: 10, durationSec: 60 },
  /** Convites: previne enumeration. 30 tentativas/hora/IP. */
  "auth.invite": { points: 30, durationSec: 3600 },
  /** Bulk-ops (import contatos, export). 5/min/org. */
  "api.bulk": { points: 5, durationSec: 60 },

  /** Bearer API tokens (n8n/integrações). Mesmo teto ORG_RATE_LIMIT_RPM por token. */
  "api.token": { points: getOrgRateLimitRpm(), durationSec: 60 },
  /**
   * Sessão cookie (NextAuth) — choke point `requireAuth` / `withOrgContext`.
   * 600/min bloqueia um loop de render (~15 req/s ≈ 900/min) e ainda cabe
   * um dashboard que dispara dezenas de APIs por load. 400 (igual Bearer)
   * é apertado demais pra UI; override `SESSION_RATE_LIMIT_RPM`.
   */
  "api.session": { points: DEFAULT_SESSION_RATE_LIMIT_RPM, durationSec: 60 },
} as const satisfies Record<string, { points: number; durationSec: number }>;

export type RateLimitProfile = keyof typeof RATE_LIMIT_PROFILES;

type RateLimiterCacheKey = string;

const limiterCache = new Map<RateLimiterCacheKey, RateLimiterAbstract>();

let sharedRedis: import("ioredis").Redis | null = null;

export function getRateLimitRedis(): import("ioredis").Redis | null {
  return getRedisOrNull();
}

function getProfileConfig(profile: RateLimitProfile): {
  points: number;
  durationSec: number;
} {
  if (profile === "api.session") {
    return { points: getSessionRateLimitRpm(), durationSec: 60 };
  }
  return RATE_LIMIT_PROFILES[profile];
}

function getRedisOrNull(): import("ioredis").Redis | null {
  // Vitest: memória, senão REDIS_URL do shell faria o consume ir pro Redis
  // e fake timers não expirariam a janela.
  if (process.env.VITEST === "true") return null;
  if (sharedRedis) return sharedRedis;
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    const IORedis = require("ioredis").default ?? require("ioredis");
    sharedRedis = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      keyPrefix: "",
      lazyConnect: false,
    });
    sharedRedis!.on("error", (err: Error) => {
      log.warn({ err }, "Redis rate-limit indisponível — fallback memória");
    });
    return sharedRedis;
  } catch (err) {
    log.warn({ err }, "Falha ao instanciar IORedis — usando memória");
    return null;
  }
}

function getLimiter(profile: RateLimitProfile): RateLimiterAbstract {
  const cfg = getProfileConfig(profile);
  const cacheKey = `${profile}:${cfg.points}:${cfg.durationSec}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const redis = getRedisOrNull();
  let limiter: RateLimiterAbstract;
  if (redis) {
    const opts: IRateLimiterStoreOptions = {
      storeClient: redis,
      keyPrefix: `rl:${profile}`,
      points: cfg.points,
      duration: cfg.durationSec,
      // Penalidade de bloqueio depois de estourar — nada mais agressivo
      // que a janela em si. Mantém comportamento "self-healing".
      blockDuration: 0,
      inMemoryBlockOnConsumed: cfg.points + 1,
      inMemoryBlockDuration: cfg.durationSec,
    };
    limiter = new RateLimiterRedis(opts);
  } else {
    limiter = new RateLimiterMemory({
      keyPrefix: `rl:${profile}`,
      points: cfg.points,
      duration: cfg.durationSec,
    });
  }
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

/** Só testes. Descarta limiters em cache (ex.: depois de mudar SESSION_RATE_LIMIT_RPM). */
export function resetRateLimitersForTests(): void {
  limiterCache.clear();
  sharedRedis = null;
}

export type RateLimitDecision = {
  allowed: boolean;
  /** Pontos restantes na janela atual. */
  remaining: number;
  /** Quando a janela reseta (epoch ms). */
  resetAt: number;
  /** Header `Retry-After` (segundos) — só faz sentido se !allowed. */
  retryAfterSec: number;
  /** Limite total da janela (header `X-RateLimit-Limit`). */
  limit: number;
};

/**
 * Consome 1 ponto da chave dada no profile especificado. Idempotente,
 * thread-safe via Lua script no Redis.
 *
 * @param key chave estável (org/user/ip + route).
 * @param profile perfil de RATE_LIMIT_PROFILES.
 * @param points ponto a consumir (default 1).
 */
export async function consumeRateLimit(
  key: string,
  profile: RateLimitProfile,
  points = 1,
): Promise<RateLimitDecision> {
  const limiter = getLimiter(profile);
  const cfg = getProfileConfig(profile);
  try {
    const res = await limiter.consume(key, points);
    return {
      allowed: true,
      remaining: res.remainingPoints,
      resetAt: Date.now() + res.msBeforeNext,
      retryAfterSec: 0,
      limit: cfg.points,
    };
  } catch (err) {
    if (err instanceof Error && !("remainingPoints" in err)) {
      // Fail-open de propósito: fail-closed travaria todos os usuários se o
      // Redis cair. Não inverter o default sem teto memória conservador +
      // circuito. Log alto pra o alerta de infra pegar a janela sem teto.
      log.error(
        { err, profile, key, failOpen: true },
        "Rate-limit infra error — FAIL-OPEN (pedido permitido). Redis down não deve derrubar a API.",
      );
      metrics.errors.inc({
        scope: "rate-limit",
        kind: "fail-open",
      });
      return {
        allowed: true,
        remaining: cfg.points,
        resetAt: Date.now() + cfg.durationSec * 1000,
        retryAfterSec: 0,
        limit: cfg.points,
      };
    }
    const r = err as RateLimiterRes;
    return {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + r.msBeforeNext,
      retryAfterSec: Math.ceil(r.msBeforeNext / 1000),
      limit: cfg.points,
    };
  }
}

export type RateLimitScope = "org" | "user" | "ip";

export type WithRateLimitOpts = {
  /** Identificador da rota (template, não path). Vai pro key e pra métrica. */
  route: string;
  /** Profile do RATE_LIMIT_PROFILES. */
  profile: RateLimitProfile;
  /** Scope da chave — fonte do "id". */
  scope: RateLimitScope;
  /** Id estável (orgId, userId, ipv4/ipv6). */
  id: string | null | undefined;
  /** Pontos a consumir. Default 1. Use >1 pra rotas pesadas (ex.: bulk import = 10). */
  points?: number;
};

/**
 * Helper de alto nível para uso em handlers. Retorna:
 *   - `{ ok: true, headers }` quando dentro do limite (anexar `headers` na resposta)
 *   - `{ ok: false, response }` quando estourado (devolver direto a `Response` 429)
 */
export async function withRateLimit(
  opts: WithRateLimitOpts,
): Promise<
  | { ok: true; headers: Record<string, string> }
  | { ok: false; response: Response; headers: Record<string, string> }
> {
  if (!opts.id) {
    // Sem id estável (request anônimo sem ip resolvido?), fail-open. Cobertura
    // melhor cai no IP via getClientIp() que sempre devolve algo.
    return { ok: true, headers: {} };
  }
  const key = `${opts.scope}:${opts.id}:${opts.route}`;
  const decision = await consumeRateLimit(key, opts.profile, opts.points ?? 1);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(Math.floor(decision.resetAt / 1000)),
  };

  if (decision.allowed) {
    return { ok: true, headers };
  }

  metrics.errors.inc({
    scope: "rate-limit",
    kind: safeLabel(`${opts.profile}:${opts.scope}`),
  });
  // 1 JSON / IP-ou-token / 10s (não 1 linha por 429). Ver logRateLimitReject.
  logRateLimitReject(`${opts.scope}:${opts.id}`, {
    profile: opts.profile,
    scope: opts.scope,
    route: opts.route,
    ip: opts.scope === "ip" ? opts.id : undefined,
    organizationId: opts.scope === "org" ? opts.id : undefined,
    limit: decision.limit,
    retryAfterSec: decision.retryAfterSec,
  });

  headers["Retry-After"] = String(decision.retryAfterSec);
  const response = new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      message: "Muitas requisições. Tente novamente em instantes.",
      retryAfterSec: decision.retryAfterSec,
    }),
    {
      status: 429,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
    },
  );
  return { ok: false, response, headers };
}

function applyConsumeRateLimitHeaders(
  headers: Headers,
  decision: RateLimitDecision,
): void {
  headers.set("X-RateLimit-Limit", String(decision.limit));
  headers.set("X-RateLimit-Remaining", String(decision.remaining));
  headers.set("X-RateLimit-Reset", String(Math.floor(decision.resetAt / 1000)));
  if (!decision.allowed) {
    headers.set("Retry-After", String(decision.retryAfterSec));
  }
}

/**
 * Teto por sessão cookie (`session:{userId}`, perfil `api.session`).
 * Choke point de `requireAuth` — cobre withOrgContext / requireRole / requireCan.
 * `/api/health`, `/api/auth`, webhooks e cron não passam por requireAuth.
 *
 * Retorna 429 se estourou; `null` se dentro do limite.
 */
export async function enforceSessionApiRateLimit(opts: {
  userId: string;
  organizationId?: string | null;
}): Promise<NextResponse | null> {
  const userId = opts.userId?.trim();
  if (!userId) return null;

  const key = sessionRateLimitKey(userId);
  const decision = await consumeRateLimit(key, "api.session");
  if (decision.allowed) return null;

  metrics.errors.inc({
    scope: "rate-limit",
    kind: safeLabel("api.session"),
  });
  logRateLimitReject(key, {
    profile: "api.session",
    scope: "user",
    organizationId: opts.organizationId?.trim() || undefined,
    limit: decision.limit,
    retryAfterSec: decision.retryAfterSec,
  });

  const headers = new Headers({ "Content-Type": "application/json" });
  applyConsumeRateLimitHeaders(headers, decision);
  return NextResponse.json(
    {
      error: "rate_limit_exceeded",
      message: "Muitas requisições. Tente novamente em instantes.",
      retryAfterSec: decision.retryAfterSec,
    },
    { status: 429, headers },
  );
}

/**
 * Extrai o IP real do cliente respeitando `TRUSTED_PROXY_HOPS` — o
 * numero de proxies confiaveis na cadeia (ex.: EasyPanel/Traefik = 1;
 * Cloudflare -> nginx -> app = 2). O IP verdadeiro do cliente e o
 * (hops+1)-esimo a partir do fim de `X-Forwarded-For`; usar o primeiro
 * IP cegamente e vulneravel a spoofing (o atacante controla o comeco
 * da lista).
 *
 * Fallback: se XFF nao existir, tenta `X-Real-IP`. Se nada disponivel,
 * retorna `"0.0.0.0"` (rate-limit continua funcionando por bucket, mas
 * a granularidade cai — visivel via logs).
 *
 * Chamado dentro de handlers Node (nao middleware Edge).
 */
export function getClientIp(req: Request): string {
  const hopsRaw = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  const hops = Number.isFinite(hopsRaw) && hopsRaw >= 0 ? hopsRaw : 1;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      // O IP do cliente e o (hops+1)-esimo contando do fim.
      // Ex.: XFF = "spoof, client, proxy1"; hops=1 -> parts.length-1-1 = 1 -> "client".
      const idx = parts.length - hops - 1;
      if (idx >= 0 && parts[idx]) return parts[idx];
      // Se hops estiver configurado alto demais e o array for menor,
      // caimos no primeiro elemento em vez de "unknown" — melhor que
      // agrupar todo mundo numa unica chave.
      return parts[0];
    }
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "0.0.0.0";
}
