/**
 * SEC-12 (limiter por IP no `authorize`) e SS-2 (callback `jwt` sem query
 * dentro da janela de 30 s). Captura a config passada ao NextAuth mockando
 * `next-auth` e o provider Credentials; sem DB/Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captured: { config: null as null | Record<string, unknown> },
  findUnique: vi.fn(),
  findMany: vi.fn(),
  withRateLimit: vi.fn(),
  checkLockout: vi.fn(),
  recordLoginAttempt: vi.fn(),
  clearFailuresOnSuccess: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: Record<string, unknown>) => {
    mocks.captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
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

vi.mock("bcryptjs", () => ({ compare: mocks.compare }));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.findUnique, findMany: mocks.findMany } },
}));
vi.mock("./prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.findUnique, findMany: mocks.findMany } },
}));

vi.mock("./rate-limit", () => ({
  getClientIp: () => "198.51.100.7",
  withRateLimit: mocks.withRateLimit,
}));

vi.mock("./auth/lockout", () => ({
  checkLockout: mocks.checkLockout,
  recordLoginAttempt: mocks.recordLoginAttempt,
  clearFailuresOnSuccess: mocks.clearFailuresOnSuccess,
}));

vi.mock("./crypto/secrets", () => ({ decryptSecret: vi.fn() }));
vi.mock("./auth/totp", () => ({ verifyTotp: vi.fn() }));
vi.mock("./auth/backup-codes", () => ({ findMatchingBackupCode: vi.fn() }));
vi.mock("./request-context", () => ({ enterRequestContext: vi.fn() }));
vi.mock("./auth.config", () => ({ default: { callbacks: {} } }));

import "./auth";
import { clearJwtRefreshCacheForTests, JWT_REFRESH_TTL_MS } from "./auth/jwt-refresh-cache";

type Authorize = (
  credentials: Record<string, unknown>,
  request?: Request,
) => Promise<unknown>;
type JwtCallback = (args: {
  token: Record<string, unknown>;
  user?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

function getAuthorize(): Authorize {
  const providers = mocks.captured.config?.providers as Array<{ authorize: Authorize }>;
  return providers[0].authorize;
}
function getJwt(): JwtCallback {
  const callbacks = mocks.captured.config?.callbacks as { jwt: JwtCallback };
  return callbacks.jwt;
}

const request = new Request("https://api.test/api/auth/callback/credentials", {
  method: "POST",
  headers: { "x-forwarded-for": "198.51.100.7" },
});

describe("authorize — SEC-12 limiter por IP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withRateLimit.mockResolvedValue({ ok: true, headers: {} });
    mocks.checkLockout.mockResolvedValue({ locked: false });
    mocks.findMany.mockResolvedValue([]);
    mocks.compare.mockResolvedValue(false);
  });

  it("consome o perfil auth.credentials por IP antes do lockout e do banco", async () => {
    const authorize = getAuthorize();
    const result = await authorize({ email: "a@b.com", password: "x" }, request);
    expect(result).toBeNull();
    expect(mocks.withRateLimit).toHaveBeenCalledWith({
      route: "auth.credentials",
      profile: "auth.credentials",
      scope: "ip",
      id: "198.51.100.7",
    });
    const order = [
      mocks.withRateLimit.mock.invocationCallOrder[0],
      mocks.checkLockout.mock.invocationCallOrder[0],
      mocks.findMany.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it("limiter estourado: lanca code=rate_limited sem lockout, banco ou bcrypt", async () => {
    mocks.withRateLimit.mockResolvedValue({
      ok: false,
      headers: {},
      response: new Response("{}", { status: 429 }),
    });
    const authorize = getAuthorize();
    await expect(
      authorize({ email: "a@b.com", password: "x" }, request),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(mocks.checkLockout).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("lockout por e-mail continua valendo depois do limiter", async () => {
    mocks.checkLockout.mockResolvedValue({ locked: true, retryAfterSec: 60 });
    const authorize = getAuthorize();
    await expect(
      authorize({ email: "a@b.com", password: "x" }, request),
    ).rejects.toMatchObject({ code: "account_locked" });
    expect(mocks.withRateLimit).toHaveBeenCalledTimes(1);
  });

  it("sem request (fora do HTTP): fail-open, nao consome limiter", async () => {
    const authorize = getAuthorize();
    await authorize({ email: "a@b.com", password: "x" });
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
  });
});

describe("jwt — SS-2 cache do refresh", () => {
  const DB_USER = {
    role: "MEMBER",
    avatarUrl: "https://cdn/a.png",
    organizationId: "org1",
    isSuperAdmin: false,
    isErased: false,
    organization: { status: "ACTIVE", slug: "acme" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearJwtRefreshCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    mocks.findUnique.mockResolvedValue(DB_USER);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1a chamada consulta o banco; dentro de 30 s nao consulta; depois consulta de novo", async () => {
    const jwt = getJwt();
    const t1 = await jwt({ token: { id: "u1" } });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(t1).toMatchObject({
      role: "MEMBER",
      organizationId: "org1",
      organizationSlug: "acme",
      isSuperAdmin: false,
      picture: "https://cdn/a.png",
    });

    vi.advanceTimersByTime(JWT_REFRESH_TTL_MS - 1000);
    const t2 = await jwt({ token: { id: "u1" } });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(t2).toMatchObject({ role: "MEMBER", organizationSlug: "acme" });

    vi.advanceTimersByTime(1000);
    await jwt({ token: { id: "u1" } });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("cache e por userId — outro usuario consulta o banco", async () => {
    const jwt = getJwt();
    await jwt({ token: { id: "u1" } });
    await jwt({ token: { id: "u2" } });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("usuario apagado / org suspensa: token vazio, e continua vazio no cache", async () => {
    mocks.findUnique.mockResolvedValue({ ...DB_USER, isErased: true });
    const jwt = getJwt();
    expect(await jwt({ token: { id: "u1", role: "MEMBER" } })).toEqual({});
    expect(await jwt({ token: { id: "u1", role: "MEMBER" } })).toEqual({});
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);

    mocks.findUnique.mockResolvedValue({
      ...DB_USER,
      organization: { status: "SUSPENDED", slug: "acme" },
    });
    expect(await jwt({ token: { id: "u3" } })).toEqual({});
  });

  it("invalidateAuthzForUser derruba o cache: proxima chamada consulta o banco", async () => {
    const { invalidateJwtRefreshCache } = await import("./auth/jwt-refresh-cache");
    const jwt = getJwt();
    await jwt({ token: { id: "u1" } });
    invalidateJwtRefreshCache("u1");
    await jwt({ token: { id: "u1" } });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("erro no banco: mantem o token e nao cacheia (tenta de novo)", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jwt = getJwt();
    const t = await jwt({ token: { id: "u1", role: "ADMIN" } });
    expect(t).toMatchObject({ id: "u1", role: "ADMIN" });
    await jwt({ token: { id: "u1", role: "ADMIN" } });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it("login (user presente): grava claims sem consultar o banco", async () => {
    const jwt = getJwt();
    const t = await jwt({
      token: {},
      user: { id: "u9", role: "ADMIN", organizationId: "o", organizationSlug: "s", isSuperAdmin: false, image: null },
    });
    expect(t).toMatchObject({ id: "u9", role: "ADMIN", organizationSlug: "s" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
