/**
 * SEC-12 (limiter por IP no `authorize`), SS-2 (callback `jwt` sem query
 * dentro da janela de 30 s), SV-1 (versão da sessão) e SV-2 (renovação da
 * sessão atual via `update()` com prova). Captura a config passada ao
 * NextAuth mockando `next-auth` e o provider Credentials; sem DB/Redis.
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
// SV-2: prova de renovação em memória (sem Redis) e auditoria muda.
vi.mock("@/lib/cache/redis-client", () => ({ getCacheClient: () => null }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: vi.fn() }));
// O logger real lê o RequestContext, que aqui é mock parcial.
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import "./auth";
import { clearJwtRefreshCacheForTests, JWT_REFRESH_TTL_MS } from "./auth/jwt-refresh-cache";
import {
  clearSessionRenewalsForTests,
  issueSessionRenewal,
} from "./auth/session-renewal";
import {
  clearSessionVersionCacheForTests,
  getCachedSessionVersion,
  invalidateSessionVersionCache,
} from "./auth/session-version";

type Authorize = (
  credentials: Record<string, unknown>,
  request?: Request,
) => Promise<unknown>;
type JwtCallback = (args: {
  token: Record<string, unknown>;
  user?: Record<string, unknown>;
  trigger?: "signIn" | "signUp" | "update";
  session?: unknown;
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
    clearSessionVersionCacheForTests();
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

describe("jwt — SV-1 versão da sessão", () => {
  const DB_USER = {
    role: "MEMBER",
    avatarUrl: null,
    organizationId: "org1",
    isSuperAdmin: false,
    isErased: false,
    sessionVersion: 0,
    organization: { status: "ACTIVE", slug: "acme" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearJwtRefreshCacheForTests();
    clearSessionVersionCacheForTests();
    mocks.findUnique.mockResolvedValue(DB_USER);
  });

  it("login grava a claim sessionVersion no token (ausente vale 0)", async () => {
    const jwt = getJwt();
    const t1 = await jwt({ token: {}, user: { id: "u9", sessionVersion: 3 } });
    expect(t1).toMatchObject({ id: "u9", sessionVersion: 3 });
    const t2 = await jwt({ token: {}, user: { id: "u8" } });
    expect(t2).toMatchObject({ id: "u8", sessionVersion: 0 });
  });

  it("refresh prima o cache de versão e a mesma consulta serve às duas checagens", async () => {
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 2 });
    const jwt = getJwt();
    const t = await jwt({ token: { id: "u1", sessionVersion: 2 } });
    expect(t).toMatchObject({ id: "u1", sessionVersion: 2 });
    expect(getCachedSessionVersion("u1")).toBe(2);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("banco incrementou (troca de senha / revoke-all): token cai (null)", async () => {
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 1 });
    const jwt = getJwt();
    // Token antigo sem a claim (vale 0) e token com claim defasada.
    expect(await jwt({ token: { id: "u1" } })).toBeNull();
    expect(await jwt({ token: { id: "u1", sessionVersion: 0 } })).toBeNull();
    // Sessão nova, emitida depois do incremento, passa.
    expect(await jwt({ token: { id: "u1", sessionVersion: 1 } })).toMatchObject({ id: "u1" });
  });

  it("token sem a claim continua válido enquanto o banco está em 0 (deploy sem logout)", async () => {
    const jwt = getJwt();
    expect(await jwt({ token: { id: "u1", role: "MEMBER" } })).toMatchObject({
      id: "u1",
      role: "MEMBER",
    });
  });

  it("cache de versão invalidado no processo: próxima chamada reconsulta e derruba", async () => {
    const jwt = getJwt();
    expect(await jwt({ token: { id: "u1" } })).toMatchObject({ id: "u1" });
    // Simula revokeUserSessions neste processo: incrementa e zera os caches.
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 1 });
    invalidateSessionVersionCache("u1");
    clearJwtRefreshCacheForTests();
    expect(await jwt({ token: { id: "u1" } })).toBeNull();
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("usuário não encontrado (hard delete): token vazio, e o estado fica em cache", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const jwt = getJwt();
    expect(await jwt({ token: { id: "u1", role: "MEMBER" } })).toEqual({});
    expect(await jwt({ token: { id: "u1", role: "MEMBER" } })).toEqual({});
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("erro no banco: cache frio não derruba (fail-open, igual ao refresh)", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jwt = getJwt();
    expect(await jwt({ token: { id: "u1", sessionVersion: 4 } })).toMatchObject({ id: "u1" });
    err.mockRestore();
  });
});

describe("jwt — SV-2 renovação da sessão atual", () => {
  // O usuário trocou a senha: o banco foi de 3 para 4. A sessão que fez o
  // pedido (claim 3) recebeu a prova; as outras sessões (também claim 3)
  // não.
  const DB_USER = {
    role: "MEMBER",
    avatarUrl: null,
    organizationId: "org1",
    isSuperAdmin: false,
    isErased: false,
    sessionVersion: 4,
    organization: { status: "ACTIVE", slug: "acme" },
  };
  const OLD_TOKEN = { id: "u1", sessionVersion: 3 };

  async function proofFor(userId = "u1", newVersion = 4, tokenVersion = 3): Promise<string> {
    const grant = await issueSessionRenewal({ userId, newVersion, tokenVersion });
    if (!grant) throw new Error("esperava uma prova");
    return grant.token;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearJwtRefreshCacheForTests();
    clearSessionVersionCacheForTests();
    clearSessionRenewalsForTests();
    mocks.findUnique.mockResolvedValue(DB_USER);
  });

  it("token revogado NÃO se auto-renova chamando update() sem prova", async () => {
    const jwt = getJwt();
    for (const session of [
      undefined,
      {},
      { name: "Fulano" },
      { sessionVersion: 4 },
      { user: { sessionVersion: 4 } },
      { sessionRenewal: true },
      { sessionRenewal: { token: "x" } },
    ]) {
      clearJwtRefreshCacheForTests();
      clearSessionVersionCacheForTests();
      expect(await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session })).toBeNull();
    }
  });

  it("token revogado NÃO se renova com prova inventada", async () => {
    await proofFor(); // existe uma prova válida no estoque, mas não é esta
    const jwt = getJwt();
    for (const forged of ["a".repeat(43), "4:u1", "x".repeat(4000)]) {
      expect(
        await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session: { sessionRenewal: forged } }),
      ).toBeNull();
    }
  });

  it("sessão que trocou a senha: update() com a prova sobe a claim e o token segue válido", async () => {
    const proof = await proofFor();
    const jwt = getJwt();
    const renewed = await jwt({
      token: { ...OLD_TOKEN },
      trigger: "update",
      session: { sessionRenewal: proof },
    });
    expect(renewed).toMatchObject({ id: "u1", sessionVersion: 4, role: "MEMBER" });
    // Requisições seguintes com o cookie renovado passam.
    expect(await jwt({ token: { ...renewed } })).toMatchObject({ id: "u1", sessionVersion: 4 });
  });

  it("uso único: outra sessão antiga do mesmo usuário com a prova copiada cai", async () => {
    const proof = await proofFor();
    const jwt = getJwt();
    expect(
      await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session: { sessionRenewal: proof } }),
    ).toMatchObject({ sessionVersion: 4 });
    expect(
      await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session: { sessionRenewal: proof } }),
    ).toBeNull();
  });

  it("a prova só vale no update: no GET da sessão (sem trigger) o token antigo cai", async () => {
    const proof = await proofFor();
    const jwt = getJwt();
    expect(await jwt({ token: { ...OLD_TOKEN }, session: { sessionRenewal: proof } })).toBeNull();
    expect(
      await jwt({ token: { ...OLD_TOKEN }, trigger: "signIn", session: { sessionRenewal: proof } }),
    ).toBeNull();
  });

  it("token revogado antes (duas versões atrás) não se renova nem com prova válida", async () => {
    const proof = await proofFor();
    const jwt = getJwt();
    expect(
      await jwt({
        token: { id: "u1", sessionVersion: 2 },
        trigger: "update",
        session: { sessionRenewal: proof },
      }),
    ).toBeNull();
  });

  it("prova de outro usuário não renova", async () => {
    const proof = await proofFor("u2");
    const jwt = getJwt();
    expect(
      await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session: { sessionRenewal: proof } }),
    ).toBeNull();
  });

  it("reset administrativo depois da troca (banco em 5): a prova da versão 4 não vale", async () => {
    const proof = await proofFor();
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 5 });
    const jwt = getJwt();
    expect(
      await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session: { sessionRenewal: proof } }),
    ).toBeNull();
  });

  it("update() repetido depois de renovar não derruba a sessão já renovada", async () => {
    const proof = await proofFor();
    const jwt = getJwt();
    const renewed = await jwt({
      token: { ...OLD_TOKEN },
      trigger: "update",
      session: { sessionRenewal: proof },
    });
    expect(
      await jwt({ token: { ...renewed }, trigger: "update", session: { sessionRenewal: proof } }),
    ).toMatchObject({ id: "u1", sessionVersion: 4 });
  });

  it("update() comum (ex.: nome) numa sessão válida continua funcionando", async () => {
    const jwt = getJwt();
    expect(
      await jwt({ token: { id: "u1", sessionVersion: 4 }, trigger: "update", session: { name: "Novo" } }),
    ).toMatchObject({ id: "u1", sessionVersion: 4 });
  });

  it("outra réplica com cache velho: prova válida renova lendo o banco, não o cache", async () => {
    const jwt = getJwt();
    // Esta réplica ainda acha que a versão é 3 (cache de antes da troca).
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 3 });
    expect(await jwt({ token: { ...OLD_TOKEN } })).toMatchObject({ sessionVersion: 3 });
    expect(getCachedSessionVersion("u1")).toBe(3);
    // A troca aconteceu em outra réplica; o update() cai aqui.
    mocks.findUnique.mockResolvedValue(DB_USER);
    const proof = await proofFor();
    expect(
      await jwt({ token: { ...OLD_TOKEN }, trigger: "update", session: { sessionRenewal: proof } }),
    ).toMatchObject({ sessionVersion: 4 });
    expect(getCachedSessionVersion("u1")).toBe(4);
    // E a sessão antiga, sem prova, cai nesta réplica também.
    expect(await jwt({ token: { ...OLD_TOKEN } })).toBeNull();
  });

  it("claim à frente do cache (sessão renovada em outra réplica): relê o banco e aceita", async () => {
    const jwt = getJwt();
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 3 });
    await jwt({ token: { ...OLD_TOKEN } });
    expect(getCachedSessionVersion("u1")).toBe(3);
    mocks.findUnique.mockResolvedValue(DB_USER);
    expect(await jwt({ token: { id: "u1", sessionVersion: 4 } })).toMatchObject({
      id: "u1",
      sessionVersion: 4,
    });
    expect(getCachedSessionVersion("u1")).toBe(4);
  });

  it("claim à frente do BANCO não passa (relê e confirma a divergência)", async () => {
    const jwt = getJwt();
    mocks.findUnique.mockResolvedValue({ ...DB_USER, sessionVersion: 3 });
    expect(await jwt({ token: { id: "u1", sessionVersion: 9 } })).toBeNull();
  });
});
