/**
 * "Trocar de organização" de ponta a ponta no `@auth/core` instalado: o
 * `update({ orgSwitch })` do `useSession` (`POST /api/auth/session`, com
 * CSRF) chega ao callback `jwt` real de `auth.ts`, que consome o ticket e
 * reemite o cookie com as claims do usuário REAL da org de destino.
 *
 * Garante:
 *  - troca completa (id/sub, org, slug, papel, `sessionVersion`, `sid` novo);
 *  - o frontend não escreve claims: `update()` com org/role/id arbitrários
 *    não muda nada;
 *  - ticket inválido, já usado, de outra sessão ou de outro usuário → token
 *    intacto (a sessão atual continua);
 *  - sessão revogada não troca nem com ticket válido;
 *  - vínculo invalidado (revogação no destino) ou destino suspenso entre a
 *    emissão e o consumo → token intacto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const state = {
    captured: { config: null as null | Record<string, unknown> },
    users: new Map<string, Record<string, unknown>>(),
    target: { current: null as null | Record<string, unknown> },
    link: { current: null as null | Record<string, unknown> },
  };
  const prisma = {
    user: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(state.users.get(args.where.id) ?? null),
      findFirst: () => Promise.resolve(state.target.current),
      findMany: () => Promise.resolve([]),
    },
    userAccountLink: {
      findUnique: () => Promise.resolve(state.link.current),
      update: () => Promise.resolve({}),
    },
  };
  return { ...state, prisma };
});

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
vi.mock("@/lib/prisma-base", () => ({ prismaBase: mocks.prisma }));
vi.mock("./prisma-base", () => ({ prismaBase: mocks.prisma }));
vi.mock("./rate-limit", () => ({ getClientIp: () => "198.51.100.7", withRateLimit: vi.fn() }));
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
import { sanitizeRevokedSessionResponse } from "./auth/revoked-session";
import { clearJwtRefreshCacheForTests } from "./auth/jwt-refresh-cache";
import { clearOrgSwitchTicketsForTests, issueOrgSwitchTicket } from "./auth/org-switch";
import { clearSessionVersionCacheForTests } from "./auth/session-version";

const SECRET = "segredo-de-teste-apenas-para-o-vitest-0123456789";
const SESSION_COOKIE = "authjs.session-token";
const BASE = "http://localhost:3000/api/auth";
const EMAIL = "pessoa@exemplo.test";

/** Conta da sessão atual (org A). */
const USER_A: Row = {
  id: "uA",
  email: EMAIL,
  type: "HUMAN",
  role: "ADMIN",
  avatarUrl: null,
  isErased: false,
  isSuperAdmin: false,
  organizationId: "orgA",
  sessionVersion: 2,
  organization: { status: "ACTIVE", slug: "acme" },
};
/** Conta REAL do mesmo e-mail na org B (registro independente). */
const USER_B: Row = {
  id: "uB",
  name: "Pessoa na Beta",
  email: EMAIL,
  role: "MEMBER",
  avatarUrl: "https://cdn.test/b.png",
  hashedPassword: "hash",
  mfaSecret: null,
  mfaEnabledAt: null,
  sessionVersion: 7,
  organizationId: "orgB",
  organization: { id: "orgB", slug: "beta", name: "Beta", logoUrl: null },
};
/** Vínculo vigente (par canônico uA < uB, versões atuais). */
const LINK = { userAId: "uA", userBId: "uB", userAVersion: 2, userBVersion: 7 };

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

async function sessionCookie(claims: Row = {}): Promise<string> {
  const jwt = await encode({
    token: {
      id: "uA",
      sub: "uA",
      name: "Pessoa",
      email: EMAIL,
      role: "ADMIN",
      organizationId: "orgA",
      organizationSlug: "acme",
      sessionVersion: 2,
      sid: "sid-A",
      ...claims,
    },
    secret: SECRET,
    salt: SESSION_COOKIE,
  });
  return `${SESSION_COOKIE}=${jwt}`;
}

async function csrf(): Promise<{ token: string; cookie: string }> {
  const res = await Auth(new Request(`${BASE}/csrf`), config());
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("authjs.csrf-token="));
  if (!cookie) throw new Error("sem cookie de CSRF");
  return { token: csrfToken, cookie: cookie.split(";")[0] };
}

type Out = {
  body: { user?: Row } | null;
  reissued: Row | null;
  cleared: boolean;
};

async function read(res: Response): Promise<Out> {
  const body = (await res.json().catch(() => null)) as Out["body"];
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const value = setCookie?.split(";")[0].slice(SESSION_COOKIE.length + 1) ?? "";
  const reissued = value
    ? ((await decode({ token: value, secret: SECRET, salt: SESSION_COOKIE })) as Row | null)
    : null;
  return { body, reissued, cleared: Boolean(setCookie) && !value };
}

async function update(cookie: string, data: unknown): Promise<Out> {
  const c = await csrf();
  const res = await Auth(
    new Request(`${BASE}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${cookie}; ${c.cookie}` },
      body: JSON.stringify({ csrfToken: c.token, data }),
    }),
    config(),
  );
  return read(await sanitizeRevokedSessionResponse(res));
}

async function ticket(over: Partial<{ fromUserId: string; sid: string; toUserId: string }> = {}) {
  const t = await issueOrgSwitchTicket({ fromUserId: "uA", sid: "sid-A", toUserId: "uB", ...over });
  return t.token;
}

beforeEach(() => {
  clearJwtRefreshCacheForTests();
  clearSessionVersionCacheForTests();
  clearOrgSwitchTicketsForTests();
  mocks.users.clear();
  mocks.users.set("uA", { ...USER_A });
  mocks.users.set("uB", { ...USER_B, type: "HUMAN", isErased: false, isSuperAdmin: false, organization: { status: "ACTIVE", slug: "beta" } });
  mocks.target.current = { ...USER_B };
  mocks.link.current = { ...LINK };
});

describe("update({ orgSwitch }) — troca de organização", () => {
  it("com ticket válido: assume o usuário real da org de destino (id, org, papel, versão, sid novo)", async () => {
    const out = await update(await sessionCookie(), { orgSwitch: await ticket() });

    expect(out.body?.user).toMatchObject({
      id: "uB",
      organizationId: "orgB",
      organizationSlug: "beta",
      role: "MEMBER",
      sessionVersion: 7,
      name: "Pessoa na Beta",
      image: "https://cdn.test/b.png",
    });
    expect(out.reissued).toMatchObject({
      id: "uB",
      sub: "uB",
      organizationId: "orgB",
      organizationSlug: "beta",
      role: "MEMBER",
      sessionVersion: 7,
      isSuperAdmin: false,
    });
    expect(out.reissued?.sid).toEqual(expect.any(String));
    expect(out.reissued?.sid).not.toBe("sid-A");
  });

  it("o cliente não escreve claims: update() com id/org/papel arbitrários não muda nada", async () => {
    const out = await update(await sessionCookie(), {
      id: "uB",
      organizationId: "orgB",
      organizationSlug: "beta",
      role: "ADMIN",
      isSuperAdmin: true,
      sessionVersion: 7,
    });
    expect(out.reissued).toMatchObject({ id: "uA", organizationId: "orgA", sessionVersion: 2 });
    expect(out.reissued?.isSuperAdmin).toBeFalsy();
  });

  it("ticket inventado, de outro usuário ou de outra sessão: sessão atual intacta", async () => {
    const forged = await update(await sessionCookie(), { orgSwitch: "a".repeat(43) });
    expect(forged.reissued).toMatchObject({ id: "uA", organizationId: "orgA" });

    const otherUser = await update(await sessionCookie(), { orgSwitch: await ticket({ fromUserId: "uX" }) });
    expect(otherUser.reissued).toMatchObject({ id: "uA", organizationId: "orgA" });

    // Ticket emitido para outra aba/dispositivo (outro `sid`) do mesmo usuário.
    const otherSid = await update(await sessionCookie(), { orgSwitch: await ticket({ sid: "sid-OUTRO" }) });
    expect(otherSid.reissued).toMatchObject({ id: "uA", organizationId: "orgA" });
  });

  it("ticket é de uso único", async () => {
    const t = await ticket();
    expect((await update(await sessionCookie(), { orgSwitch: t })).reissued).toMatchObject({ id: "uB" });
    const replay = await update(await sessionCookie(), { orgSwitch: t });
    expect(replay.reissued).toMatchObject({ id: "uA", organizationId: "orgA" });
  });

  it("revogação: sessão de origem revogada não troca, mesmo com ticket válido", async () => {
    mocks.users.set("uA", { ...USER_A, sessionVersion: 3 }); // "sair de todos os dispositivos"
    const out = await update(await sessionCookie(), { orgSwitch: await ticket() });
    expect(out.body).toBeNull();
    expect(out.cleared).toBe(true);
  });

  it("revogação no destino depois do vínculo (versão subiu): vínculo não vale, sessão intacta", async () => {
    mocks.target.current = { ...USER_B, sessionVersion: 8 };
    const out = await update(await sessionCookie(), { orgSwitch: await ticket() });
    expect(out.reissued).toMatchObject({ id: "uA", organizationId: "orgA", sessionVersion: 2 });
  });

  it("destino deixou de ser elegível (org suspensa / usuário removido): sessão intacta", async () => {
    mocks.target.current = null;
    const out = await update(await sessionCookie(), { orgSwitch: await ticket() });
    expect(out.reissued).toMatchObject({ id: "uA", organizationId: "orgA" });
  });

  it("sem vínculo gravado não troca (e-mail igual sozinho não autoriza)", async () => {
    mocks.link.current = null;
    const out = await update(await sessionCookie(), { orgSwitch: await ticket() });
    expect(out.reissued).toMatchObject({ id: "uA", organizationId: "orgA" });
  });

  it("o ticket não vale no GET da sessão", async () => {
    await ticket();
    const res = await Auth(new Request(`${BASE}/session`, { headers: { cookie: await sessionCookie() } }), config());
    const out = await read(await sanitizeRevokedSessionResponse(res));
    expect(out.body?.user).toMatchObject({ id: "uA", organizationId: "orgA" });
  });
});
