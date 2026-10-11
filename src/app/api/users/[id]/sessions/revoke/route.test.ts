/**
 * POST /api/users/[id]/sessions/revoke — admin encerra as sessões de outro
 * usuário da mesma org. `requireAdmin` e `revokeUserSessions` reais; só a
 * sessão (`auth()`), o banco, a SSE e a auditoria são mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    auth: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null as unknown),
    revokeUser: vi.fn(),
    logAuditAsync: vi.fn(),
  };
});

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/api-access-audit", () => ({
  logApiAccessRequireAuthFail: vi.fn().mockResolvedValue(undefined),
  logApiAccessCompleted: vi.fn().mockResolvedValue(undefined),
  readApiAccessHeaders: vi.fn().mockResolvedValue({ method: "POST", path: "/api/x" }),
  resolveResponseStatus: () => 200,
}));
vi.mock("@/lib/metrics", () => ({ observeHttpRequest: vi.fn(), metrics: {} }));
vi.mock("@/lib/rate-limit", () => ({ enforceSessionApiRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/org-rate-limit", () => ({ enforceOrgApiRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findFirst: h.findFirst } } }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { update: h.update, findUnique: h.findUnique } },
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { revokeUser: h.revokeUser } }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: h.logAuditAsync }));

import { POST } from "@/app/api/users/[id]/sessions/revoke/route";

/** Usuários do "banco": u-alvo na org-a, u-fora na org-b. */
const USERS = [
  { id: "u-alvo", organizationId: "org-a", type: "HUMAN" },
  { id: "u-fora", organizationId: "org-b", type: "HUMAN" },
  { id: "ia-1", organizationId: "org-a", type: "AI" },
];

function adminSession(role: "ADMIN" | "MANAGER" | "MEMBER" = "ADMIN") {
  return {
    user: { id: "admin-1", name: "Admin", role, organizationId: "org-a", isSuperAdmin: false },
  };
}

function call(id: string) {
  return POST(new Request(`https://api.test/api/users/${id}/sessions/revoke`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue(null);
  h.auth.mockResolvedValue(adminSession());
  // Mesmo filtro que a rota manda (id + type + escopo da org da sessão).
  h.findFirst.mockImplementation(
    async ({ where }: { where: { id: string; type?: string; organizationId?: string } }) => {
      const u = USERS.find(
        (x) =>
          x.id === where.id &&
          (where.type === undefined || x.type === where.type) &&
          (where.organizationId === undefined || x.organizationId === where.organizationId),
      );
      return u ? { id: u.id, organizationId: u.organizationId } : null;
    },
  );
  h.update.mockResolvedValue({ sessionVersion: 7 });
});

describe("POST /api/users/[id]/sessions/revoke", () => {
  it("admin da mesma org → 200 { ok, sessionVersion }, incrementa e derruba a SSE", async () => {
    const res = await call("u-alvo");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionVersion: 7 });
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { id: "u-alvo", type: "HUMAN", organizationId: "org-a" },
      select: { id: true, organizationId: true },
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "u-alvo" },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });
    expect(h.revokeUser).toHaveBeenCalledWith({ userId: "u-alvo", organizationId: "org-a" });
  });

  it("audit log sessions_revoked com reason admin_revoke e o admin como ator", async () => {
    await call("u-alvo");
    expect(h.logAuditAsync).toHaveBeenCalledWith({
      entity: "user",
      action: "sessions_revoked",
      entityId: "u-alvo",
      organizationId: "org-a",
      actorId: "admin-1",
      metadata: { reason: "admin_revoke" },
    });
  });

  it("não-admin (MANAGER, MEMBER) → 403 sem tocar no banco", async () => {
    for (const role of ["MANAGER", "MEMBER"] as const) {
      h.auth.mockResolvedValue(adminSession(role));
      const res = await call("u-alvo");
      expect(res.status).toBe(403);
    }
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("usuário de outra org → 404 igual a id inexistente (não vaza existência)", async () => {
    const other = await call("u-fora");
    const missing = await call("nao-existe");
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(h.update).not.toHaveBeenCalled();
    expect(h.revokeUser).not.toHaveBeenCalled();
    expect(h.logAuditAsync).not.toHaveBeenCalled();
  });

  it("agente de IA (sem sessão de login) → 404", async () => {
    expect((await call("ia-1")).status).toBe(404);
  });

  it("sessão revogada do próprio admin → 401 SESSION_REVOKED (requireAuth)", async () => {
    h.auth.mockResolvedValue({ revoked: true, revokedReason: "session_revoked" });
    const res = await call("u-alvo");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("SESSION_REVOKED");
  });

  it("erro do banco no incremento → 500", async () => {
    h.update.mockRejectedValue(new Error("db down"));
    const res = await call("u-alvo");
    expect(res.status).toBe(500);
  });
});
