/**
 * "Ganhos por agente" (`getPainelAgents`): quem entra na lista e o que é
 * `openToday` (rótulo "Ativos hoje" na tela).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    user: { findMany: h.userFindMany },
    deal: { groupBy: h.groupBy },
  }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/services/kanban-filters", () => ({
  buildDealWhereFromFilters: async () => [],
}));
vi.mock("@/services/painel-snapshots", () => ({ ensureTodayDealStageSnapshot: vi.fn() }));
vi.mock("@/services/dashboard", () => ({ SOURCE_NONE: "__none__" }));

import { getPainelAgents } from "@/services/painel-deals";

const RANGE = {
  from: new Date("2026-10-12T03:00:00Z"),
  to: new Date("2026-10-13T02:59:59Z"),
};
const FILTERS = { range: RANGE, pipelineIds: ["p1"], stalledDays: 7 };

type GroupArgs = { where: { AND?: unknown[] } & Record<string, unknown> };
const whereText = (args: GroupArgs) => JSON.stringify(args.where);

beforeEach(() => {
  h.userFindMany.mockReset();
  h.groupBy.mockReset();
  h.userFindMany.mockResolvedValue([
    { id: "u_admin", name: "Admin Sistema" },
    { id: "u_ana", name: "Ana" },
  ]);
  h.groupBy.mockImplementation(async (args: GroupArgs) => {
    const w = whereText(args);
    if (w.includes('"WON"')) {
      return [{ ownerId: "u_ana", _count: { _all: 2 }, _sum: { value: 3000 } }];
    }
    if (w.includes('"LOST"')) return [{ ownerId: "u_ana", _count: { _all: 2 } }];
    if (w.includes('"OPEN"')) {
      return [
        { ownerId: "u_admin", _count: { _all: 13471 } },
        { ownerId: "u_ana", _count: { _all: 5 } },
      ];
    }
    return [];
  });
});

describe("getPainelAgents", () => {
  it("lista só humanos sem super-admin (mesmo recorte de atendentes do Agora)", async () => {
    await getPainelAgents(FILTERS);
    expect(h.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org_1", type: "HUMAN", isSuperAdmin: false },
      }),
    );
  });

  it("openToday é a carteira aberta atual: OPEN sem recorte de data", async () => {
    const rows = await getPainelAgents(FILTERS);
    const openCall = h.groupBy.mock.calls
      .map((c) => c[0] as GroupArgs)
      .find((a) => whereText(a).includes('"OPEN"'))!;
    expect(whereText(openCall)).not.toMatch(/closedAt|createdAt|updatedAt/);

    const admin = rows.find((r) => r.id === "u_admin")!;
    expect(admin.openToday).toBe(13471);
    expect(admin.wonCount).toBe(0);
    expect(admin.zeroActivity).toBe(false);

    // Ganho no período ordena antes de carteira grande.
    expect(rows[0].id).toBe("u_ana");
    expect(rows[0]).toMatchObject({ wonCount: 2, wonValue: 3000, conversion: 50, openToday: 5 });
  });

  it("ganhos e perdas usam closedAt no período", async () => {
    await getPainelAgents(FILTERS);
    const calls = h.groupBy.mock.calls.map((c) => whereText(c[0] as GroupArgs));
    for (const status of ['"WON"', '"LOST"']) {
      const w = calls.find((c) => c.includes(status))!;
      expect(w).toContain("closedAt");
      expect(w).toContain(RANGE.from.toISOString());
    }
  });
});
