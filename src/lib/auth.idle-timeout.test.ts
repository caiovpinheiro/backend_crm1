/**
 * Expiração por inatividade real de ponta a ponta: login (callback `jwt`
 * real cria o `sid` e registra atividade) → wrapper `auth()` real →
 * `requireAuth` real → rotas reais de ping e activity. Só o next-auth
 * (sessão decodificada), o banco e o Redis (falso, em memória) são mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeIoredisModule, newFakeRedisState } from "@/test-setup/fake-cache-redis";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    captured: { config: null as null | Record<string, unknown> },
    nextAuthAuth: vi.fn(),
    client: { current: null as unknown },
    requireAuthFail: vi.fn().mockResolvedValue(undefined),
    recordHeartbeatThrottled: vi.fn().mockResolvedValue({ created: false, written: true }),
    recordSystemActivity: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("next-auth", () => ({
  default: (config: Record<string, unknown>) => {
    h.captured.config = config;
    return { handlers: {}, auth: h.nextAuthAuth, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: Record<string, unknown>) => opts,
}));
vi.mock("@auth/core/errors", () => ({
  CredentialsSignin: class CredentialsSignin extends Error {
    code = "credentials";
  },
}));
vi.mock("bcryptjs", () => ({ compare: vi.fn() }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn() } },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "198.51.100.7",
  withRateLimit: vi.fn(),
  enforceSessionApiRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/org-rate-limit", () => ({ enforceOrgApiRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/lockout", () => ({
  checkLockout: vi.fn(),
  recordLoginAttempt: vi.fn(),
  clearFailuresOnSuccess: vi.fn(),
}));
vi.mock("@/lib/crypto/secrets", () => ({ decryptSecret: vi.fn() }));
vi.mock("@/lib/auth/totp", () => ({ verifyTotp: vi.fn() }));
vi.mock("@/lib/auth/backup-codes", () => ({ findMatchingBackupCode: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ default: { callbacks: {} } }));
vi.mock("@/services/email-verification", () => ({ resendVerificationOnLogin: vi.fn() }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: vi.fn() }));
vi.mock("@/lib/api-access-audit", () => ({
  logApiAccessRequireAuthFail: h.requireAuthFail,
  logApiAccessCompleted: vi.fn().mockResolvedValue(undefined),
  readApiAccessHeaders: vi.fn().mockResolvedValue({ method: "POST", path: "/api/x" }),
  resolveResponseStatus: (r: unknown) =>
    r && typeof r === "object" && "status" in r ? (r as { status: number }).status : 200,
}));
vi.mock("@/lib/metrics", () => ({ observeHttpRequest: vi.fn(), metrics: {} }));
vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => h.client.current,
  noteSuccess: vi.fn(),
  noteFailure: vi.fn(),
  waitUntilCacheReady: async () => false,
}));
vi.mock("@/services/system-presence", () => ({
  recordHeartbeatThrottled: h.recordHeartbeatThrottled,
}));
vi.mock("@/services/system-activity", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/services/system-activity")>();
  return { clampInteractionCount: orig.clampInteractionCount, recordSystemActivity: h.recordSystemActivity };
});

import { POST as activity } from "@/app/api/agents/me/activity/route";
import { POST as ping } from "@/app/api/agents/me/ping/route";
import { requireAuth } from "@/lib/auth-helpers";
import { clearSessionActivityCacheForTests } from "@/lib/auth/session-activity";
import { requestContext } from "@/lib/request-context";

import "./auth";

type JwtCallback = (args: {
  token: Record<string, unknown>;
  user?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;

/** Login real: o callback `jwt` grava o `sid` e registra a atividade. */
async function login(): Promise<string> {
  const jwt = (h.captured.config?.callbacks as { jwt: JwtCallback }).jwt;
  const token = await jwt({
    token: {},
    user: { id: "u1", role: "MEMBER", organizationId: "org1", isSuperAdmin: false, sessionVersion: 0 },
  });
  expect(typeof token.sid).toBe("string");
  return token.sid as string;
}

/** O que o `auth()` do next-auth devolveria para o cookie desta sessão. */
function useSession(sid?: string) {
  h.nextAuthAuth.mockResolvedValue({
    user: {
      id: "u1",
      name: "Ana",
      role: "MEMBER",
      organizationId: "org1",
      isSuperAdmin: false,
      sessionVersion: 0,
      ...(sid ? { sid } : {}),
    },
    expires: "2026-12-01T00:00:00.000Z",
  });
}

/** Avança o relógio e esquece o cache em memória (outra réplica / > 30 s). */
function at(ms: number) {
  vi.setSystemTime(ms);
  clearSessionActivityCacheForTests();
}

function fresh<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run(undefined as never, fn);
}

const pingReq = () => new Request("https://api.test/api/agents/me/ping", { method: "POST" });
const activityReq = (body: unknown) =>
  new Request("https://api.test/api/agents/me/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.clearAllMocks();
  const { default: FakeRedis } = fakeIoredisModule(newFakeRedisState());
  h.client.current = new FakeRedis();
  delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
  at(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inatividade real de 12 h (requireAuth)", () => {
  it("atividade há 11 h → ok; há 13 h → 401 SESSION_REVOKED com log idle_timeout", async () => {
    useSession(await login());

    at(T0 + 11 * HOUR);
    expect((await fresh(() => requireAuth())).ok).toBe(true);

    at(T0 + 13 * HOUR);
    const r = await fresh(() => requireAuth());
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({
      message: "Sessão expirada. Entre novamente.",
      code: "SESSION_REVOKED",
    });
    expect(h.requireAuthFail).toHaveBeenCalledWith("idle_timeout");
  });

  it("ping NÃO renova: pings de hora em hora e a sessão expira 12 h após a última atividade", async () => {
    useSession(await login());
    for (let i = 1; i <= 11; i++) {
      at(T0 + i * HOUR);
      expect((await ping(pingReq())).status).toBe(200);
    }
    at(T0 + 12 * HOUR + 60_000);
    const res = await ping(pingReq());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("SESSION_REVOKED");
  });

  it("activity com pulsos renova; com 0 pulsos não renova", async () => {
    useSession(await login());

    at(T0 + 11 * HOUR);
    expect(await (await activity(activityReq({ interactionCount: 3 }))).json()).toEqual({ ok: true });
    expect(h.recordSystemActivity).toHaveBeenCalledTimes(1);

    at(T0 + 22 * HOUR);
    expect((await fresh(() => requireAuth())).ok).toBe(true);
    // 0 pulsos às 22 h: responde ok mas não é atividade (nem grava uso).
    expect(await (await activity(activityReq({ interactionCount: 0 }))).json()).toEqual({
      ok: true,
      recorded: false,
    });
    expect(h.recordSystemActivity).toHaveBeenCalledTimes(1);

    at(T0 + 23 * HOUR + 60_000);
    expect((await fresh(() => requireAuth())).ok).toBe(false);
  });

  it("sem registro (deploy, token antigo sem sid): semeia agora e passa; expira 12 h depois", async () => {
    useSession(undefined);
    expect((await fresh(() => requireAuth())).ok).toBe(true);
    at(T0 + 11 * HOUR);
    expect((await fresh(() => requireAuth())).ok).toBe(true);
    at(T0 + 12 * HOUR + 60_000);
    expect((await fresh(() => requireAuth())).ok).toBe(false);
  });

  it("SESSION_IDLE_TIMEOUT_HOURS ajusta o limite", async () => {
    process.env.SESSION_IDLE_TIMEOUT_HOURS = "1";
    useSession(await login());
    at(T0 + 2 * HOUR);
    expect((await fresh(() => requireAuth())).ok).toBe(false);
  });

  it("Redis fora: fail-open — ninguém é deslogado", async () => {
    useSession(await login());
    h.client.current = null;
    at(T0 + 48 * HOUR);
    expect((await fresh(() => requireAuth())).ok).toBe(true);
  });
});
