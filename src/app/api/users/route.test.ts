/**
 * GET /api/users — campo `telephony` em cada usuário: mesmo objeto de
 * `GET /api/users/:id/telephony`, mesma regra de acesso (só ADMIN), uma
 * consulta de telefonia para a lista inteira (sem N+1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeUser = { id: string; name: string; organizationId: string | null };
type FakeExt = {
  userId: string;
  organizationId: string;
  telephonyEnabled: boolean;
  provisioningStep: string;
  provisioningError: string | null;
  provisionedAt: Date | null;
};

const h = vi.hoisted(() => ({
  session: {
    user: {
      id: "admin",
      role: "ADMIN" as string,
      organizationId: "org1" as string | null,
      isSuperAdmin: false,
    },
  },
  users: [] as FakeUser[],
  exts: [] as FakeExt[],
  sipFindMany: vi.fn(),
  sipFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userFindFirst: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ ok: true, session: h.session }),
  requireAdmin: async () => ({ ok: true, session: h.session }),
  withOrgContext: async (handler: (s: unknown) => unknown) => handler(h.session),
  userOrgFilter: (s: { user: { organizationId: string | null; isSuperAdmin: boolean } }) =>
    s.user.organizationId
      ? { organizationId: s.user.organizationId }
      : s.user.isSuperAdmin
        ? {}
        : { organizationId: "__none__" },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findMany: h.userFindMany, findFirst: h.userFindFirst },
    sipExtension: { findMany: h.sipFindMany, findUnique: h.sipFindUnique },
  },
}));
vi.mock("@/services/system-presence", () => ({
  getSystemPresenceMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/authz/sync-user-role", () => ({ syncUserRoleAssignment: vi.fn() }));
vi.mock("@/lib/public-id", () => ({ nextUserNumber: vi.fn() }));
vi.mock("@/services/call-provider-configs", () => ({
  getOrCreateApi4ComProviderConfig: vi.fn(),
  resolveApi4ComServiceToken: vi.fn(),
  resolveOrgApi4ComGateway: vi.fn(),
}));

import { GET as getTelephonyById } from "@/app/api/users/[id]/telephony/route";
import { GET as listUsers } from "@/app/api/users/route";

const PROVISIONED_AT = new Date("2026-10-01T12:00:00.000Z");

function makeUsers(n: number): FakeUser[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i + 1}`,
    name: `Pessoa ${i + 1}`,
    organizationId: "org1",
  }));
}

async function list(): Promise<Array<Record<string, unknown>>> {
  const res = await listUsers(new Request("https://api.test/api/users"));
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

async function byId(id: string): Promise<Response> {
  return getTelephonyById(new Request(`https://api.test/api/users/${id}/telephony`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session.user = { id: "admin", role: "ADMIN", organizationId: "org1", isSuperAdmin: false };
  h.users = makeUsers(3);
  h.exts = [
    {
      userId: "u1",
      organizationId: "org1",
      telephonyEnabled: true,
      provisioningStep: "DONE",
      provisioningError: null,
      provisionedAt: PROVISIONED_AT,
    },
    {
      userId: "u3",
      organizationId: "org1",
      telephonyEnabled: false,
      provisioningStep: "CREATE_EXTENSION",
      provisioningError: "falhou na Api4com",
      provisionedAt: null,
    },
  ];
  h.userFindMany.mockImplementation(async () =>
    h.users.map((u) => ({
      ...u,
      number: 1,
      email: `${u.id}@x.test`,
      role: "MEMBER",
      type: "HUMAN",
      avatarUrl: null,
      phone: null,
      roleAssignments: [],
      agentStatus: null,
    })),
  );
  h.userFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const u = h.users.find((x) => x.id === where.id);
    return u ? { id: u.id, organizationId: u.organizationId } : null;
  });
  h.sipFindMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
    h.exts.filter((e) => where.userId.in.includes(e.userId)),
  );
  h.sipFindUnique.mockImplementation(
    async ({
      where,
    }: {
      where: { organizationId_userId: { organizationId: string; userId: string } };
    }) => {
      const k = where.organizationId_userId;
      const e = h.exts.find((x) => x.organizationId === k.organizationId && x.userId === k.userId);
      return e
        ? {
            telephonyEnabled: e.telephonyEnabled,
            provisioningStep: e.provisioningStep,
            provisioningError: e.provisioningError,
            provisionedAt: e.provisionedAt,
          }
        : null;
    },
  );
});

describe("GET /api/users — telephony", () => {
  it("ADMIN: cada usuário traz o mesmo objeto de GET /api/users/:id/telephony", async () => {
    const rows = await list();
    for (const row of rows) {
      const res = await byId(row.id as string);
      expect(res.status).toBe(200);
      expect(row.telephony).toEqual(await res.json());
    }
    expect(rows.map((r) => r.telephony)).toEqual([
      {
        telephonyEnabled: true,
        provisioningStep: "DONE",
        provisioningError: null,
        provisionedAt: PROVISIONED_AT.toISOString(),
      },
      { telephonyEnabled: false, provisioningStep: "IDLE", provisioningError: null, provisionedAt: null },
      {
        telephonyEnabled: false,
        provisioningStep: "CREATE_EXTENSION",
        provisioningError: "falhou na Api4com",
        provisionedAt: null,
      },
    ]);
    // `organizationId` só serve para casar o ramal; não entra na resposta.
    expect(rows[0]).not.toHaveProperty("organizationId");
  });

  it("número constante de consultas de telefonia: 1 para 3 usuários, 1 para 40", async () => {
    await list();
    expect(h.sipFindMany).toHaveBeenCalledTimes(1);
    expect(h.sipFindUnique).not.toHaveBeenCalled();

    vi.clearAllMocks();
    h.users = makeUsers(40);
    const rows = await list();
    expect(rows).toHaveLength(40);
    expect(rows.every((r) => r.telephony !== undefined)).toBe(true);
    expect(h.sipFindMany).toHaveBeenCalledTimes(1);
    expect(h.sipFindUnique).not.toHaveBeenCalled();
  });

  it("não ADMIN (MANAGER/MEMBER): sem o campo telephony e sem consulta — a rota por id dá 403", async () => {
    for (const role of ["MANAGER", "MEMBER"]) {
      vi.clearAllMocks();
      h.session.user = { id: "x", role, organizationId: "org1", isSuperAdmin: false };
      const rows = await list();
      expect(rows.length).toBe(3);
      for (const row of rows) expect(row).not.toHaveProperty("telephony");
      expect(h.sipFindMany).not.toHaveBeenCalled();
      expect((await byId("u1")).status).toBe(403);
    }
  });

  it("usuário sem org (super-admin listando tudo): telephony null — a rota por id dá 404", async () => {
    h.session.user = { id: "sa", role: "ADMIN", organizationId: null, isSuperAdmin: true };
    h.users = [...makeUsers(1), { id: "orfao", name: "Sem org", organizationId: null }];
    const rows = await list();
    expect(rows.find((r) => r.id === "orfao")?.telephony).toBeNull();
    expect((await byId("orfao")).status).toBe(404);
    expect(rows.find((r) => r.id === "u1")?.telephony).toEqual(await (await byId("u1")).json());
  });

  it("ramal de outra org não vale para o usuário (casa por org + usuário)", async () => {
    h.exts = [{ ...h.exts[0]!, organizationId: "org2" }];
    const rows = await list();
    expect(rows[0]?.telephony).toEqual(await (await byId("u1")).json());
    expect((rows[0]?.telephony as { provisioningStep: string }).provisioningStep).toBe("IDLE");
  });

  it("falha na consulta de telefonia não derruba a lista (sem o campo)", async () => {
    h.sipFindMany.mockRejectedValueOnce(new Error("db"));
    const rows = await list();
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row).not.toHaveProperty("telephony");
  });
});
