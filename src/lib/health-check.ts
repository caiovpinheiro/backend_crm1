/**
 * Checagem de saúde compartilhada por `/api/health` (JSON) e `/health`
 * (HTML).
 *
 * Público (sem credencial): só o estado agregado — `ok` ou `degraded`.
 * O detalhe (Postgres, Redis, latências, uptime, mensagens de erro) revela
 * a pilha e o estado da infraestrutura e só sai para:
 *  - quem manda o token de `HEALTH_TOKEN` (`X-Health-Token: <token>` ou
 *    `Authorization: Bearer <token>`), pensado para o monitor; ou
 *  - sessão de super-admin da plataforma.
 * Sem `HEALTH_TOKEN` configurado, só o super-admin vê o detalhe.
 *
 * O resultado é reaproveitado por 2 s no processo: a rota é pública e cada
 * checagem custa um `SELECT 1` + `PING` — sem isso, um loop de requests
 * anônimos viraria carga no banco.
 */
import IORedis from "ioredis";

import { prisma } from "@/lib/prisma";

const HEALTH_TIMEOUT_MS = 2000;
const RESULT_MEMO_MS = 2000;

const startedAt = Date.now();

const globalForHealth = globalThis as unknown as {
  healthRedis?: IORedis;
};

export type HealthCheckResult =
  | { ok: true; latencyMs: number }
  | { ok: false; error: string };

export type HealthSnapshot = {
  ok: boolean;
  db: HealthCheckResult;
  redis: HealthCheckResult;
};

function getHealthRedis(): IORedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!globalForHealth.healthRedis) {
    globalForHealth.healthRedis = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: HEALTH_TIMEOUT_MS,
      commandTimeout: HEALTH_TIMEOUT_MS,
      enableOfflineQueue: false,
      reconnectOnError: () => false,
    });
    globalForHealth.healthRedis.on("error", () => {
      // silencia: o ping abaixo já reporta o erro pro caller.
    });
  }
  return globalForHealth.healthRedis;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout após ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkPostgres(): Promise<HealthCheckResult> {
  const t0 = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_TIMEOUT_MS, "postgres");
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkRedis(): Promise<HealthCheckResult> {
  const t0 = Date.now();
  const redis = getHealthRedis();
  if (!redis) return { ok: false, error: "REDIS_URL não configurado" };
  try {
    if (redis.status === "wait" || redis.status === "end") {
      await withTimeout(redis.connect(), HEALTH_TIMEOUT_MS, "redis-connect");
    }
    const pong = await withTimeout(redis.ping(), HEALTH_TIMEOUT_MS, "redis-ping");
    if (pong !== "PONG") return { ok: false, error: `resposta inesperada: ${pong}` };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let memo: { at: number; snapshot: HealthSnapshot } | null = null;
let inFlight: Promise<HealthSnapshot> | null = null;

export function getHealthSnapshot(): Promise<HealthSnapshot> {
  if (memo && Date.now() - memo.at < RESULT_MEMO_MS) {
    return Promise.resolve(memo.snapshot);
  }
  if (inFlight) return inFlight;
  inFlight = Promise.all([checkPostgres(), checkRedis()])
    .then(([db, redis]) => {
      const snapshot: HealthSnapshot = { ok: db.ok && redis.ok, db, redis };
      memo = { at: Date.now(), snapshot };
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function healthUptimeSec(): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function hasHealthToken(request: Request): boolean {
  const expected = process.env.HEALTH_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("x-health-token")?.trim() ?? "";
  const authz = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+/i.test(authz) ? authz.replace(/^Bearer\s+/i, "").trim() : "";
  return (
    (header.length > 0 && timingSafeEqual(header, expected)) ||
    (bearer.length > 0 && timingSafeEqual(bearer, expected))
  );
}

async function isSuperAdminSession(request: Request): Promise<boolean> {
  // Sem cookie de sessão não há o que validar — o monitor anônimo não paga
  // o custo do `auth()`.
  if (!/session-token/.test(request.headers.get("cookie") ?? "")) return false;
  try {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    return Boolean((session?.user as { isSuperAdmin?: boolean } | undefined)?.isSuperAdmin);
  } catch {
    return false;
  }
}

/** Token do monitor ou sessão de super-admin. */
export async function canSeeHealthDetail(request: Request): Promise<boolean> {
  if (hasHealthToken(request)) return true;
  return isSuperAdminSession(request);
}

export function resetHealthMemoForTests(): void {
  memo = null;
  inFlight = null;
}
