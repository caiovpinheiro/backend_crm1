/**
 * GET /api/me/organizations — lista para o seletor "Trocar de organização":
 * org atual primeiro (marcada), demais orgs do MESMO e-mail com `linked`
 * calculado pelo vínculo vigente. Sem conta elegível (super-admin etc.):
 * lista vazia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  loadSourceAccount: vi.fn(),
  listEligibleTargets: vi.fn(),
  linksOf: vi.fn(),
  orgFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { organization: { findUnique: mocks.orgFindUnique } },
}));
vi.mock("@/lib/auth/org-switch", async (orig) => {
  const real = await orig<typeof import("@/lib/auth/org-switch")>();
  return {
    isLinkCurrent: real.isLinkCurrent,
    loadSourceAccount: mocks.loadSourceAccount,
    listEligibleTargets: mocks.listEligibleTargets,
    linksOf: mocks.linksOf,
  };
});
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/cache/redis-client", () => ({ getCacheClient: () => null }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: vi.fn() }));

import { NextResponse } from "next/server";

import { GET } from "./route";

const SESSION = { user: { id: "uA", role: "ADMIN", organizationId: "orgA", isSuperAdmin: false } };
const SOURCE = { id: "uA", email: "p@x.test", organizationId: "orgA", sessionVersion: 2 };

function target(id: string, org: string, name: string, sessionVersion: number) {
  return {
    id,
    role: "MEMBER",
    sessionVersion,
    organizationId: org,
    organization: { id: org, slug: org.toLowerCase(), name, logoUrl: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ ok: true, session: SESSION });
  mocks.loadSourceAccount.mockResolvedValue(SOURCE);
  mocks.orgFindUnique.mockResolvedValue({ id: "orgA", slug: "acme", name: "Acme", logoUrl: null });
  mocks.listEligibleTargets.mockResolvedValue([
    target("uC", "orgC", "Zeta", 1),
    target("uB", "orgB", "Beta", 7),
  ]);
  mocks.linksOf.mockResolvedValue(
    new Map([
      // uB: vínculo vigente (versões atuais).
      ["uB", { userAId: "uA", userBId: "uB", userAVersion: 2, userBVersion: 7 }],
      // uC: vínculo antigo — uC trocou a senha depois (versão 0 → 1).
      ["uC", { userAId: "uA", userBId: "uC", userAVersion: 2, userBVersion: 0 }],
    ]),
  );
});

describe("GET /api/me/organizations", () => {
  it("sem sessão: devolve a resposta do requireAuth", async () => {
    mocks.requireAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ message: "Não autorizado." }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);
    expect(mocks.loadSourceAccount).not.toHaveBeenCalled();
  });

  it("org atual primeiro e marcada; outras em ordem alfabética com `linked` pelo vínculo vigente", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentOrganizationId).toBe("orgA");
    expect(body.organizations).toEqual([
      { organizationId: "orgA", slug: "acme", name: "Acme", logoUrl: null, role: "ADMIN", current: true, linked: true },
      { organizationId: "orgB", slug: "orgb", name: "Beta", logoUrl: null, role: "MEMBER", current: false, linked: true },
      // Revogação no destino invalidou o vínculo: volta a pedir senha.
      { organizationId: "orgC", slug: "orgc", name: "Zeta", logoUrl: null, role: "MEMBER", current: false, linked: false },
    ]);
    expect(mocks.loadSourceAccount).toHaveBeenCalledWith("uA");
  });

  it("conta inelegível (super-admin, org suspensa): lista vazia", async () => {
    mocks.loadSourceAccount.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body.organizations).toEqual([]);
    expect(mocks.listEligibleTargets).not.toHaveBeenCalled();
  });
});
