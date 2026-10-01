/**
 * SV-2 de ponta a ponta no `@auth/core` instalado (next-auth v5 beta): o
 * `POST /api/auth/session` — o `update()` do `useSession` — entrega ao
 * callback `jwt` `trigger: "update"` + o corpo `data`, e reemite o cookie
 * com o que o callback devolver. É disso que a renovação depende; se uma
 * atualização do next-auth mudar esse contrato, este teste quebra.
 *
 * Aqui roda o `Auth()` real (JWT cifrado de verdade, CSRF de verdade) com
 * os callbacks reais de `auth.ts`; só o banco e o Redis são mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captured: { config: null as null | Record<string, unknown> },
  findUnique: vi.fn(),
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
vi.mock("bcryptjs", () => ({ compare: vi.fn() }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.findUnique, findMany: vi.fn() } },
}));
vi.mock("./prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.findUnique, findMany: vi.fn() } },
}));
vi.mock("./rate-limit", () => ({
  getClientIp: () => "198.51.100.7",
  withRateLimit: vi.fn(),
}));
vi.mock("./auth/lockout", () => ({
  checkLockout: vi.fn(),
  recordLoginAttempt: vi.fn(),
  clearFailuresOnSuccess: vi.fn(),
}));
vi.mock("./crypto/secrets", () => ({ decryptSecret: vi.fn() }));
vi.mock("./auth/totp", () => ({ verifyTotp: vi.fn() }));
vi.mock("./auth/backup-codes", () => ({ findMatchingBackupCode: vi.fn() }));
vi.mock("./request-context", () => ({ enterRequestContext: vi.fn() }));
vi.mock("./auth.config", () => ({ default: { callbacks: {} } }));
vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => null,
  waitUntilCacheReady: async () => false,
}));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { Auth, type AuthConfig } from "@auth/core";
import { decode, encode } from "@auth/core/jwt";

import "./auth";
import { clearJwtRefreshCacheForTests } from "./auth/jwt-refresh-cache";
import {
  clearSessionRenewalsForTests,
  issueSessionRenewal,
} from "./auth/session-renewal";
import { clearSessionVersionCacheForTests } from "./auth/session-version";

const SECRET = "segredo-de-teste-apenas-para-o-vitest-0123456789";
const SESSION_COOKIE = "authjs.session-token";
const BASE = "http://localhost:3000/api/auth";

const DB_USER = {
  role: "MEMBER",
  avatarUrl: null,
  organizationId: "org1",
  isSuperAdmin: false,
  isErased: false,
  sessionVersion: 4,
  organization: { status: "ACTIVE", slug: "acme" },
};

function config(): AuthConfig {
  return {
    secret: SECRET,
    trustHost: true,
    basePath: "/api/auth",
    session: { strategy: "jwt" },
    providers: [],
    callbacks: mocks.captured.config?.callbacks as AuthConfig["callbacks"],
    logger: { error() {}, warn() {}, debug() {} },
  };
}

/** Cookie de sessão como o login emitiria, com a claim pedida. */
async function sessionCookie(sessionVersion: number, userId = "u1"): Promise<string> {
  const jwt = await encode({
    token: { id: userId, sub: userId, name: "Fulano", email: "f@acme.test", sessionVersion },
    secret: SECRET,
    salt: SESSION_COOKIE,
  });
  return `${SESSION_COOKIE}=${jwt}`;
}

async function csrf(): Promise<{ token: string; cookie: string }> {
  const res = await Auth(new Request(`${BASE}/csrf`), config());
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("authjs.csrf-token="));
  if (!cookie) throw new Error("sem cookie de CSRF");
  return { token: csrfToken, cookie: cookie.split(";")[0] };
}

type SessionResult = {
  status: number;
  body: { user?: { id?: string; sessionVersion?: number } } | null;
  /** Claims do cookie de sessão reemitido; `null` = cookie apagado/ausente. */
  reissued: Record<string, unknown> | null;
  cleared: boolean;
};

async function read(res: Response): Promise<SessionResult> {
  const body = (await res.json().catch(() => null)) as SessionResult["body"];
  const setCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = setCookie?.split(";")[0].slice(SESSION_COOKIE.length + 1) ?? "";
  const reissued = value
    ? ((await decode({ token: value, secret: SECRET, salt: SESSION_COOKIE })) as Record<
        string,
        unknown
      > | null)
    : null;
  return { status: res.status, body, reissued, cleared: Boolean(setCookie) && !value };
}

/** `update(data)` do `useSession`: POST /api/auth/session com CSRF. */
async function update(cookie: string, data: unknown): Promise<SessionResult> {
  const c = await csrf();
  const res = await Auth(
    new Request(`${BASE}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${cookie}; ${c.cookie}` },
      body: JSON.stringify({ csrfToken: c.token, data }),
    }),
    config(),
  );
  return read(res);
}

async function getSession(cookie: string): Promise<SessionResult> {
  return read(await Auth(new Request(`${BASE}/session`, { headers: { cookie } }), config()));
}

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
  // Banco na versão 4: o usuário acabou de trocar a senha (era 3).
  mocks.findUnique.mockResolvedValue(DB_USER);
});

describe("POST /api/auth/session (update) — renovação da sessão atual", () => {
  it("com a prova: devolve a sessão na versão nova e reemite o cookie com a claim nova", async () => {
    const proof = await proofFor();
    const out = await update(await sessionCookie(3), { sessionRenewal: proof });

    expect(out.status).toBe(200);
    expect(out.body?.user).toMatchObject({ id: "u1", sessionVersion: 4 });
    expect(out.reissued).toMatchObject({ id: "u1", sessionVersion: 4 });

    // O cookie reemitido segue válido nas próximas leituras.
    const jwt = await encode({ token: out.reissued ?? {}, secret: SECRET, salt: SESSION_COOKIE });
    const next = await getSession(`${SESSION_COOKIE}=${jwt}`);
    expect(next.body?.user).toMatchObject({ id: "u1", sessionVersion: 4 });
  });

  it("token revogado NÃO se auto-renova: update() sem prova apaga o cookie", async () => {
    for (const data of [undefined, {}, { name: "Fulano" }, { sessionVersion: 4 }]) {
      const out = await update(await sessionCookie(3), data);
      expect(out.body).toBeNull();
      expect(out.reissued).toBeNull();
      expect(out.cleared).toBe(true);
    }
  });

  it("token revogado NÃO se renova com prova inventada nem com a prova já usada", async () => {
    const forged = await update(await sessionCookie(3), { sessionRenewal: "a".repeat(43) });
    expect(forged.body).toBeNull();
    expect(forged.cleared).toBe(true);

    const proof = await proofFor();
    expect((await update(await sessionCookie(3), { sessionRenewal: proof })).body?.user).toMatchObject({
      sessionVersion: 4,
    });
    // Outra sessão antiga do mesmo usuário reapresenta a mesma prova.
    const replay = await update(await sessionCookie(3), { sessionRenewal: proof });
    expect(replay.body).toBeNull();
    expect(replay.cleared).toBe(true);
  });

  it("token duas versões atrás não se renova nem com prova válida", async () => {
    const proof = await proofFor();
    const out = await update(await sessionCookie(2), { sessionRenewal: proof });
    expect(out.body).toBeNull();
    expect(out.cleared).toBe(true);
  });

  it("a prova não vale no GET da sessão nem sem o CSRF do update", async () => {
    const proof = await proofFor();
    const cookie = await sessionCookie(3);

    // GET: não há corpo — o token antigo simplesmente cai.
    const viaGet = await getSession(cookie);
    expect(viaGet.body).toBeNull();
    expect(viaGet.cleared).toBe(true);

    // POST sem token de CSRF: o core recusa antes de chamar o callback.
    const res = await Auth(
      new Request(`${BASE}/session`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ data: { sessionRenewal: proof } }),
      }),
      config(),
    );
    const noCsrf = await read(res);
    expect(noCsrf.body?.user?.sessionVersion).not.toBe(4);
    expect(noCsrf.reissued).toBeNull();
  });

  it("sessão válida: update() comum continua devolvendo a sessão", async () => {
    const out = await update(await sessionCookie(4), { name: "Novo Nome" });
    expect(out.body?.user).toMatchObject({ id: "u1", sessionVersion: 4 });
    expect(out.reissued).toMatchObject({ sessionVersion: 4 });
  });
});
