/**
 * `lib/auth-helpers` — guardas de rota sem NextAuth/Postgres/Redis (CL-15).
 *
 * Cobre `requireAuth` (401 sem sessão / sessão sem org, rate limit,
 * RequestContext ativado), `requireRole`/`requireAdmin`/`requireSuperAdmin`
 * (403), `requireCan` (403 com `required`), `userOrgFilter` (bypass só
 * para super-admin SEM org ativa) e `withOrgContext`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    auth: vi.fn(),
    requireAuthFail: vi.fn().mockResolvedValue(undefined),
    accessCompleted: vi.fn().mockResolvedValue(undefined),
    sessionRpm: vi.fn().mockResolvedValue(null as Response | null),
    orgRpm: vi.fn().mockResolvedValue(null as Response | null),
    assignmentsFindMany: vi.fn().mockResolvedValue([] as unknown[]),
    // SV-1: `select { sessionVersion }` do requireAuth com cache frio.
    userFindUnique: vi.fn().mockResolvedValue(null as unknown),
  };
});

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/api-access-audit", () => ({
  logApiAccessRequireAuthFail: h.requireAuthFail,
  logApiAccessCompleted: h.accessCompleted,
  readApiAccessHeaders: vi.fn().mockResolvedValue({ method: "GET", path: "/api/x" }),
  resolveResponseStatus: (r: unknown) =>
    r && typeof r === "object" && "status" in r ? (r as { status: number }).status : 200,
}));
vi.mock("@/lib/metrics", () => ({
  observeHttpRequest: vi.fn(),
  metrics: {},
  safeLabel: (v: unknown) => String(v),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceSessionApiRateLimit: h.sessionRpm }));
vi.mock("@/lib/org-rate-limit", () => ({ enforceOrgApiRateLimit: h.orgRpm }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    userRoleAssignment: { findMany: h.assignmentsFindMany },
    user: { findUnique: h.userFindUnique },
    role: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
// Só espiona `enterRequestContext`; o AsyncLocalStorage continua o real.
vi.mock("@/lib/request-context", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/request-context")>();
  return { ...orig, enterRequestContext: vi.fn(orig.enterRequestContext) };
});

import { NextResponse } from "next/server";

import {
  isAdmin,
  isManagerOrAdmin,
  requireAdmin,
  requireAuth,
  requireCan,
  requireManager,
  requireRole,
  requireSuperAdmin,
  runInSessionContext,
  userOrgFilter,
  withOrgContext,
} from "@/lib/auth-helpers";
import { clearSessionVersionCacheForTests } from "@/lib/auth/session-version";
import {
  enterRequestContext,
  getRequestContext,
  requestContext,
} from "@/lib/request-context";

let userSeq = 0;
function session(over: Partial<{
  id: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
  organizationId: string | null;
  isSuperAdmin: boolean;
  name: string | null;
  email: string | null;
  sessionVersion: number;
}> = {}) {
  userSeq += 1;
  return {
    user: {
      ...(over.sessionVersion === undefined ? {} : { sessionVersion: over.sessionVersion }),
      id: over.id ?? `user-${userSeq}`,
      name: over.name === undefined ? "Ana" : over.name,
      email: over.email === undefined ? "ana@x.com" : over.email,
      role: over.role ?? "MEMBER",
      organizationId: over.organizationId === undefined ? "org-a" : over.organizationId,
      isSuperAdmin: over.isSuperAdmin ?? false,
    },
  };
}

/** Roda `fn` sem RequestContext herdado (isola o `enterWith` do requireAuth). */
function fresh<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run(undefined as never, fn);
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionVersionCacheForTests();
  h.sessionRpm.mockResolvedValue(null);
  h.orgRpm.mockResolvedValue(null);
  h.assignmentsFindMany.mockResolvedValue([]);
  h.userFindUnique.mockResolvedValue(null);
});

describe("requireAuth", () => {
  it("sem sessão → 401 e auditoria `no_session`", async () => {
    h.auth.mockResolvedValue(null);
    const r = await fresh(() => requireAuth());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(await bodyOf(r.response)).toEqual({ message: "Não autorizado." });
    expect(h.requireAuthFail).toHaveBeenCalledWith("no_session");
    expect(h.sessionRpm).not.toHaveBeenCalled();
  });

  it("token zerado pelo callback jwt (user sem id) → 401 `no_session`", async () => {
    h.auth.mockResolvedValue({ user: { name: undefined, email: undefined, image: undefined } });
    const r = await fresh(() => requireAuth());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(h.requireAuthFail).toHaveBeenCalledWith("no_session");
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("SV-1: banco incrementou sessionVersion → 401 `session_revoked` antes do rate limit", async () => {
    h.auth.mockResolvedValue(session({ id: "user-sv", sessionVersion: 1 }));
    h.userFindUnique.mockResolvedValue({ sessionVersion: 2 });
    const r = await fresh(() => requireAuth());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(await bodyOf(r.response)).toEqual({
      message: "Sessão expirada. Entre novamente.",
      code: "SESSION_REVOKED",
    });
    expect(h.requireAuthFail).toHaveBeenCalledWith("session_revoked");
    expect(h.userFindUnique).toHaveBeenCalledWith({
      where: { id: "user-sv" },
      select: { sessionVersion: true },
    });
    expect(h.sessionRpm).not.toHaveBeenCalled();
  });

  it("SV-1: versão igual passa e fica em cache; token antigo sem claim vale 0", async () => {
    h.userFindUnique.mockResolvedValue({ sessionVersion: 1 });
    h.auth.mockResolvedValue(session({ id: "user-sv2", sessionVersion: 1 }));
    expect((await fresh(() => requireAuth())).ok).toBe(true);
    expect((await fresh(() => requireAuth())).ok).toBe(true);
    expect(h.userFindUnique).toHaveBeenCalledTimes(1);

    // Claim ausente (token de antes do deploy) × banco ainda em 0: válido.
    h.userFindUnique.mockResolvedValue({ sessionVersion: 0 });
    h.auth.mockResolvedValue(session({ id: "user-old" }));
    expect((await fresh(() => requireAuth())).ok).toBe(true);
  });

  it("SV-1: sem veredito (linha ausente / banco fora) deixa passar", async () => {
    h.auth.mockResolvedValue(session({ id: "user-nv", sessionVersion: 5 }));
    h.userFindUnique.mockResolvedValue(null);
    expect((await fresh(() => requireAuth())).ok).toBe(true);
    h.userFindUnique.mockRejectedValue(new Error("db down"));
    expect((await fresh(() => requireAuth())).ok).toBe(true);
  });

  it("usuário comum sem organizationId → 401 (estado corrompido, não confia no JWT)", async () => {
    h.auth.mockResolvedValue(session({ organizationId: null }));
    const r = await fresh(() => requireAuth());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(h.requireAuthFail).toHaveBeenCalledWith("session_missing_organization");
  });

  it("super-admin sem org passa", async () => {
    h.auth.mockResolvedValue(session({ organizationId: null, isSuperAdmin: true }));
    const r = await fresh(() => requireAuth());
    expect(r.ok).toBe(true);
  });

  it("rate limit da sessão/org devolve a resposta 429 do limitador", async () => {
    h.auth.mockResolvedValue(session());
    const limited = NextResponse.json({ message: "slow" }, { status: 429 });
    h.sessionRpm.mockResolvedValueOnce(limited);
    const r1 = await fresh(() => requireAuth());
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.response).toBe(limited);
    expect(h.orgRpm).not.toHaveBeenCalled();

    h.orgRpm.mockResolvedValueOnce(limited);
    const r2 = await fresh(() => requireAuth());
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.response.status).toBe(429);
  });

  it("sessão válida ativa o RequestContext com org/usuário/ator humano", async () => {
    const s = session({ id: "user-ctx", organizationId: "org-ctx", name: "  Bia " });
    h.auth.mockResolvedValue(s);
    const r = await fresh(() => requireAuth());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.session).toBe(s);
    // Se o `enterWith` chega ao CHAMADOR depois do `await` depende do
    // runtime (Node ≤22 propaga; Node 24 com AsyncContextFrame não), por
    // isso a asserção é no que o helper ativa, não no store do caller.
    expect(vi.mocked(enterRequestContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enterRequestContext)).toHaveBeenCalledWith({
      organizationId: "org-ctx",
      userId: "user-ctx",
      isSuperAdmin: false,
      actor: { type: "HUMAN", label: "Bia" },
    });
    expect(h.sessionRpm).toHaveBeenCalledWith({ userId: "user-ctx", organizationId: "org-ctx" });
    expect(h.orgRpm).toHaveBeenCalledWith({
      organizationId: "org-ctx",
      isSuperAdmin: false,
      viaToken: false,
    });
  });
});

describe("requireRole / requireAdmin / requireManager / requireSuperAdmin", () => {
  it("MEMBER em rota de ADMIN → 403 'Acesso negado.'", async () => {
    h.auth.mockResolvedValue(session({ role: "MEMBER" }));
    const r = await fresh(() => requireAdmin());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
    expect(await bodyOf(r.response)).toEqual({ message: "Acesso negado." });
  });

  it("MANAGER passa em requireManager mas não em requireAdmin; role desconhecido é negado", async () => {
    h.auth.mockResolvedValue(session({ role: "MANAGER" }));
    expect((await fresh(() => requireManager())).ok).toBe(true);
    expect((await fresh(() => requireAdmin())).ok).toBe(false);

    h.auth.mockResolvedValue({ ...session(), user: { ...session().user, role: "ROOT" } });
    expect((await fresh(() => requireRole(["ADMIN", "MANAGER", "MEMBER"]))).ok).toBe(false);
  });

  it("401 de requireAuth propaga sem virar 403", async () => {
    h.auth.mockResolvedValue(null);
    const r = await fresh(() => requireAdmin());
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
  });

  it("requireSuperAdmin nega ADMIN comum (403) e aceita super-admin", async () => {
    h.auth.mockResolvedValue(session({ role: "ADMIN" }));
    const r = await fresh(() => requireSuperAdmin());
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);

    h.auth.mockResolvedValue(session({ isSuperAdmin: true }));
    expect((await fresh(() => requireSuperAdmin())).ok).toBe(true);
  });

  it("helpers síncronos", () => {
    expect(isAdmin(session({ role: "ADMIN" }))).toBe(true);
    expect(isAdmin(session({ role: "MANAGER" }))).toBe(false);
    expect(isManagerOrAdmin(session({ role: "MANAGER" }))).toBe(true);
    expect(isManagerOrAdmin(null)).toBe(false);
  });
});

describe("requireCan", () => {
  it("permissão ausente → 403 com `required`; presente → session + ctx", async () => {
    h.auth.mockResolvedValue(session({ id: "user-can" }));
    h.assignmentsFindMany.mockResolvedValue([
      { role: { systemPreset: null, permissions: ["contact:view"], stageGrants: [], pipelineGrants: [], fieldGrants: [] } },
    ]);

    const denied = await fresh(() => requireCan("pipeline:edit"));
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.response.status).toBe(403);
    expect(await bodyOf(denied.response)).toEqual({
      message: "Acesso negado.",
      required: "pipeline:edit",
    });

    const ok = await fresh(() => requireCan("contact:view"));
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.ctx.userId).toBe("user-can");
    expect(ok.ctx.permissions.has("contact:view")).toBe(true);
  });

  it("carrega o contexto de authz com a org DA SESSÃO", async () => {
    h.auth.mockResolvedValue(session({ id: "user-org", organizationId: "org-q" }));
    await fresh(() => requireCan("contact:view"));
    const args = h.assignmentsFindMany.mock.calls[0]![0] as { where: unknown };
    expect(args.where).toEqual({ userId: "user-org", organizationId: "org-q" });
  });
});

describe("userOrgFilter", () => {
  it("org ativa manda, inclusive para super-admin dentro de uma org", () => {
    expect(userOrgFilter({ user: { organizationId: "org-a", isSuperAdmin: false } })).toEqual({
      organizationId: "org-a",
    });
    expect(userOrgFilter({ user: { organizationId: "org-a", isSuperAdmin: true } })).toEqual({
      organizationId: "org-a",
    });
  });

  it("super-admin sem org = visão global; usuário sem org = nada", () => {
    expect(userOrgFilter({ user: { organizationId: null, isSuperAdmin: true } })).toEqual({});
    expect(userOrgFilter({ user: { organizationId: null, isSuperAdmin: false } })).toEqual({
      organizationId: "__none__",
    });
  });
});

describe("withOrgContext", () => {
  it("roda o handler dentro do contexto da sessão e audita a conclusão", async () => {
    h.auth.mockResolvedValue(session({ id: "user-w", organizationId: "org-w" }));
    const out = await fresh(() =>
      withOrgContext(async (s) => {
        expect(getRequestContext()?.organizationId).toBe("org-w");
        return NextResponse.json({ ok: s.user.id });
      }),
    );
    expect((out as Response).status).toBe(200);
    expect(h.accessCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, userId: "user-w", organizationId: "org-w" }),
    );
  });

  it("runInSessionContext: contexto explícito e determinístico (independe do enterWith)", async () => {
    const s = session({ id: "user-r", organizationId: "org-r" });
    const seen = await fresh(() =>
      runInSessionContext(s, async () => getRequestContext()),
    );
    expect(seen).toMatchObject({ organizationId: "org-r", userId: "user-r", isSuperAdmin: false });
    expect(await fresh(async () => getRequestContext())).toBeUndefined();
  });

  it("sem sessão devolve o 401 sem executar o handler", async () => {
    h.auth.mockResolvedValue(null);
    const handler = vi.fn();
    const out = (await fresh(() => withOrgContext(handler))) as Response;
    expect(out.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("exceção do handler é auditada como 500 e propagada", async () => {
    h.auth.mockResolvedValue(session());
    await expect(
      fresh(() =>
        withOrgContext(async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(h.accessCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }));
  });
});
