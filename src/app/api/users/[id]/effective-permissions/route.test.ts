/**
 * GET /api/users/[id]/effective-permissions — isolamento por org.
 *
 * Mocka withOrgContext (sessão injetada), authz e os clientes Prisma para
 * validar que o alvo é filtrado por `userOrgFilter` (404 para usuário de
 * outra org) e que AgentPermission é lida pela org do alvo, nunca só por
 * userId.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type SessionUser = {
  id: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
};

const state = vi.hoisted(() => ({
  session: {
    user: { id: "admin_a", organizationId: "org_a", isSuperAdmin: false } as SessionUser,
  },
  userFindFirst: vi.fn(),
  roleFindMany: vi.fn(),
  channelFindMany: vi.fn(),
  agentPermFindFirst: vi.fn(),
}));

// `auth-helpers` real puxa next-auth (next/server) — fora do alcance do
// vitest. `userOrgFilter` é replicado com a mesma regra: org ativa tem
// prioridade; bypass só para super-admin SEM org; sem nada → "__none__".
vi.mock("@/lib/auth-helpers", () => ({
  userOrgFilter: (session: { user: SessionUser }) => {
    if (session.user.organizationId) {
      return { organizationId: session.user.organizationId };
    }
    if (session.user.isSuperAdmin) return {};
    return { organizationId: "__none__" };
  },
  withOrgContext: (fn: (session: typeof state.session) => unknown) =>
    fn(state.session),
}));

vi.mock("@/lib/authz", () => ({
  loadAuthzContext: async (input: {
    userId: string;
    organizationId: string | null;
    isSuperAdmin: boolean;
  }) => ({
    isSuperAdmin: input.isSuperAdmin,
    isAdmin: false,
    permissions: new Set<string>(["deal:view"]),
  }),
  can: () => true,
}));

vi.mock("@/lib/authz/scope-grants", () => ({
  getScopeGrants: async () => ({}),
}));

vi.mock("@/lib/authz/scope-grants-shared", () => ({
  listAllowedChannelIdsForUser: () => null,
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findFirst: state.userFindFirst } },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    userRoleAssignment: { findMany: state.roleFindMany },
    channel: { findMany: state.channelFindMany },
    agentPermission: { findFirst: state.agentPermFindFirst },
  },
}));

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/users/[id]/effective-permissions — isolamento", () => {
  beforeEach(() => {
    state.session = {
      user: { id: "admin_a", organizationId: "org_a", isSuperAdmin: false },
    };
    state.userFindFirst.mockReset();
    state.roleFindMany.mockReset().mockResolvedValue([]);
    state.channelFindMany.mockReset().mockResolvedValue([]);
    state.agentPermFindFirst.mockReset().mockResolvedValue(null);
  });

  it("404 para usuário de outra org (filtro pela org da sessão)", async () => {
    // O banco não devolve o usuário porque o where inclui organizationId=org_a.
    state.userFindFirst.mockResolvedValue(null);
    const { GET } = await import("./route");

    const res = await GET(new Request("http://localhost"), ctx("user_b"));

    expect(res.status).toBe(404);
    expect(state.userFindFirst).toHaveBeenCalledTimes(1);
    const args = state.userFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ id: "user_b", organizationId: "org_a" });
    expect(state.agentPermFindFirst).not.toHaveBeenCalled();
  });

  it("200 para colega da mesma org e AgentPermission filtrada pela org do alvo", async () => {
    state.userFindFirst.mockResolvedValue({
      id: "user_a2",
      role: "MEMBER",
      organizationId: "org_a",
      isSuperAdmin: false,
    });
    state.agentPermFindFirst.mockResolvedValue({ canConfigureFieldVisibility: true });
    const { GET } = await import("./route");

    const res = await GET(new Request("http://localhost"), ctx("user_a2"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toContain("settings:custom_fields");
    const args = state.agentPermFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ userId: "user_a2", organizationId: "org_a" });
  });

  it("super-admin sem org ativa consulta sem filtro de org (plataforma)", async () => {
    state.session = {
      user: { id: "root", organizationId: null, isSuperAdmin: true },
    };
    state.userFindFirst.mockResolvedValue({
      id: "user_b",
      role: "MEMBER",
      organizationId: "org_b",
      isSuperAdmin: false,
    });
    const { GET } = await import("./route");

    const res = await GET(new Request("http://localhost"), ctx("user_b"));

    expect(res.status).toBe(200);
    const args = state.userFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ id: "user_b" });
  });
});
