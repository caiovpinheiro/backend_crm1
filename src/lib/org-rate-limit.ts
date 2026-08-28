/**
 * Rate-limit duro: 400 req/min por organização (sliding window 60s).
 *
 * Conta
 * ─────
 * Requisições autenticadas do CRM com `organizationId` resolvido:
 * sessão NextAuth (`requireAuth` e derivados), Bearer/API token e
 * `withApiAuthContext` (inclui API pública autenticada).
 *
 * Não conta
 * ─────────
 * - Webhooks inbound de plataforma (`/api/webhooks/*` — Meta WhatsApp,
 *   Stripe, provedor de chamadas). São callbacks, não uso da API da org.
 * - Cron (`/api/cron`), health (`/api/health`), auth (`/api/auth`).
 * - Super-admin (sem bucket de org).
 * - Jobs/workers via `withResolvedContext` (não passam pelos wrappers).
 * - Login/signup sem org (já têm perfil `auth.public` por IP).
 *
 * Choke point: `requireAuth` + `authenticateApiRequest` — um consume
 * por request autenticada, não por rota.
 *
 * Store: Redis ZSET (`org:{organizationId}:rpm`) quando `REDIS_URL`
 * existe; senão Map in-memory **por processo** (N réplicas = N×teto).
 * Override: `ORG_RATE_LIMIT_RPM` (default 400).
 */

import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import { metrics, safeLabel } from "@/lib/metrics";
import {
  getOrgRateLimitRpm,
  isOrgRpmExemptPath,
  orgRpmKey,
  ORG_RATE_LIMIT_WINDOW_MS,
} from "@/lib/org-rate-limit-config";
import { getRateLimitRedis } from "@/lib/rate-limit";
import {
  logRateLimitReject,
  resetRateLimitRejectLogForTests,
} from "@/lib/rate-limit-reject-log";
import { checkRateLimit, resetRateLimitMemory } from "@/lib/rate-limiter";

const log = getLogger("org-rate-limit");

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = tonumber(redis.call('ZCARD', key))
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = window
  if oldest[2] then
    resetMs = math.max(0, tonumber(oldest[2]) + window - now)
  end
  return {0, limit, 0, resetMs}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetMs = window
if oldest[2] then
  resetMs = math.max(0, tonumber(oldest[2]) + window - now)
end
return {1, limit, limit - count - 1, resetMs}
`;

export type OrgRateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
};

export type ConsumeOrgRpmOpts = {
  now?: number;
  limit?: number;
  windowMs?: number;
  /** Força memória (testes / sem Redis). Default: Redis se `REDIS_URL`. */
  store?: "memory" | "auto";
};

let warnedMemory = false;

function useMemoryStore(store: ConsumeOrgRpmOpts["store"]): boolean {
  if (store === "memory") return true;
  if (process.env.VITEST === "true") return true;
  return !process.env.REDIS_URL?.trim();
}

function toDecision(
  allowed: boolean,
  limit: number,
  remaining: number,
  retryAfterSec: number,
  now: number,
): OrgRateLimitDecision {
  const retry = Math.max(0, retryAfterSec);
  return {
    allowed,
    limit,
    remaining: Math.max(0, remaining),
    retryAfterSec: retry,
    resetAt: now + retry * 1000,
  };
}

function consumeMemory(
  organizationId: string,
  now: number,
  limit: number,
  windowMs: number,
): OrgRateLimitDecision {
  const result = checkRateLimit(orgRpmKey(organizationId), limit, windowMs, now);
  return toDecision(
    result.allowed,
    result.limit,
    result.remaining,
    result.resetInSeconds,
    now,
  );
}

function parseLua(raw: unknown, limit: number, now: number): OrgRateLimitDecision {
  const row = Array.isArray(raw) ? raw : [];
  const allowed = Number(row[0]) === 1;
  const parsedLimit = Number(row[1]);
  const remaining = Number(row[2]);
  const resetMs = Number(row[3]);
  const retryAfterSec = Number.isFinite(resetMs)
    ? Math.ceil(Math.max(0, resetMs) / 1000)
    : 60;
  return toDecision(
    allowed,
    Number.isFinite(parsedLimit) ? parsedLimit : limit,
    Number.isFinite(remaining) ? remaining : 0,
    retryAfterSec,
    now,
  );
}

/**
 * Consome 1 ponto do bucket `org:{id}:rpm` (sliding window).
 * Falha de Redis → fail-open (não derruba a API).
 */
export async function consumeOrgRpm(
  organizationId: string,
  opts: ConsumeOrgRpmOpts = {},
): Promise<OrgRateLimitDecision> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? getOrgRateLimitRpm();
  const windowMs = opts.windowMs ?? ORG_RATE_LIMIT_WINDOW_MS;

  if (useMemoryStore(opts.store)) {
    if (!warnedMemory && opts.store !== "memory") {
      warnedMemory = true;
      log.warn(
        "ORG RPM in-memory — REDIS_URL ausente; teto vale por processo, não entre réplicas",
      );
    }
    return consumeMemory(organizationId, now, limit, windowMs);
  }

  const redis = getRateLimitRedis();
  if (!redis) {
    if (!warnedMemory) {
      warnedMemory = true;
      log.warn(
        "ORG RPM in-memory — Redis indisponível; teto vale por processo",
      );
    }
    return consumeMemory(organizationId, now, limit, windowMs);
  }

  const key = orgRpmKey(organizationId);
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  try {
    const raw = await redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(now),
      String(windowMs),
      String(limit),
      member,
    );
    return parseLua(raw, limit, now);
  } catch (err) {
    log.error({ err, key }, "ORG RPM Redis error — fail-open");
    return toDecision(true, limit, limit, 0, now);
  }
}

export function applyOrgRateLimitHeaders(
  headers: Headers,
  decision: OrgRateLimitDecision,
): void {
  headers.set("X-RateLimit-Limit", String(decision.limit));
  headers.set("X-RateLimit-Remaining", String(decision.remaining));
  headers.set("X-RateLimit-Reset", String(Math.floor(decision.resetAt / 1000)));
  if (!decision.allowed) {
    headers.set("Retry-After", String(decision.retryAfterSec));
  }
}

export function orgRateLimitResponse(decision: OrgRateLimitDecision): NextResponse {
  const headers = new Headers({ "Content-Type": "application/json" });
  applyOrgRateLimitHeaders(headers, decision);
  return NextResponse.json(
    {
      error: "rate_limit",
      limit: decision.limit,
      retryAfterSec: decision.retryAfterSec,
    },
    { status: 429, headers },
  );
}

/**
 * Retorna 429 se a org estourou o teto; `null` se isento ou dentro do limite.
 */
export async function enforceOrgApiRateLimit(opts: {
  organizationId: string | null | undefined;
  isSuperAdmin?: boolean;
  pathname?: string;
}): Promise<NextResponse | null> {
  if (opts.isSuperAdmin) return null;
  if (opts.pathname && isOrgRpmExemptPath(opts.pathname)) return null;
  const organizationId = opts.organizationId?.trim();
  if (!organizationId) return null;

  const decision = await consumeOrgRpm(organizationId);
  if (decision.allowed) return null;

  metrics.errors.inc({
    scope: "rate-limit",
    kind: safeLabel("org.rpm"),
  });
  logRateLimitReject(`org:${organizationId}`, {
    profile: "org.rpm",
    scope: "org",
    organizationId,
    route: opts.pathname,
    limit: decision.limit,
    retryAfterSec: decision.retryAfterSec,
  });
  return orgRateLimitResponse(decision);
}

export function resetOrgRpmMemoryForTests(): void {
  resetRateLimitMemory();
  warnedMemory = false;
  resetRateLimitRejectLogForTests();
}

export {
  getOrgRateLimitRpm,
  isOrgRpmExemptPath,
  orgRpmKey,
} from "@/lib/org-rate-limit-config";
