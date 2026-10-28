/**
 * Card "Motivo de perda" (`getPainelLossReasons`) e a seção `lossReasons`,
 * que só roda quando pedida.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  groupBy: vi.fn(),
  buildWhere: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({ deal: { groupBy: h.groupBy } }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/services/kanban-filters", () => ({
  buildDealWhereFromFilters: h.buildWhere,
}));
vi.mock("@/services/painel-snapshots", () => ({ ensureTodayDealStageSnapshot: vi.fn() }));
vi.mock("@/services/dashboard", () => ({ SOURCE_NONE: "__none__" }));

import { getPainelLossReasons, parseDealSections } from "@/services/painel-deals";

const RANGE = {
  from: new Date("2026-10-01T03:00:00Z"),
  to: new Date("2026-11-01T02:59:59Z"),
};
const FILTERS = { range: RANGE, pipelineIds: ["p1"], stalledDays: 7 };

beforeEach(() => {
  h.groupBy.mockReset();
  h.buildWhere.mockReset();
  h.buildWhere.mockResolvedValue([]);
  h.groupBy.mockResolvedValue([
    { lostReason: "Preço", _count: { _all: 3 }, _sum: { value: 1500 } },
    { lostReason: " Preço ", _count: { _all: 1 }, _sum: { value: 500 } },
    { lostReason: "Sem interesse", _count: { _all: 5 }, _sum: { value: null } },
    { lostReason: null, _count: { _all: 2 }, _sum: { value: 100 } },
    { lostReason: "  ", _count: { _all: 1 }, _sum: { value: 0 } },
  ]);
});

describe("getPainelLossReasons", () => {
  it("conta perdidos com closedAt no período", async () => {
    await getPainelLossReasons(FILTERS);
    const args = h.groupBy.mock.calls[0]![0] as { by: string[]; where: unknown };
    expect(args.by).toEqual(["lostReason"]);
    expect(args.where).toEqual({
      AND: [{ status: "LOST", closedAt: { gte: RANGE.from, lte: RANGE.to } }],
    });
  });

  it("agrupa motivo com espaços e vazio vira Sem motivo, ordenado por quantidade", async () => {
    const card = await getPainelLossReasons(FILTERS);
    expect(card.items).toEqual([
      { reason: "Sem interesse", count: 5, value: 0 },
      { reason: "Preço", count: 4, value: 2000 },
      { reason: "Sem motivo", count: 3, value: 100 },
    ]);
    expect(card.total).toBe(12);
    expect(card.totalValue).toBe(2100);
  });

  it("aplica os filtros do painel (responsáveis, etapas, tags)", async () => {
    await getPainelLossReasons({
      ...FILTERS,
      ownerIds: ["u1"],
      stageIds: ["s1"],
      tagIds: ["t1"],
    });
    expect(h.buildWhere).toHaveBeenCalledWith({
      pipelineId: "p1",
      stageIds: ["s1"],
      tagIds: ["t1"],
      tagMode: "any",
      ownerIds: ["u1"],
    });
  });
});

describe("parseDealSections", () => {
  it("sem section não roda lossReasons", () => {
    expect(parseDealSections(null)).not.toContain("lossReasons");
  });
  it("lossReasons roda quando pedido", () => {
    expect(parseDealSections("lossReasons")).toEqual(["lossReasons"]);
  });
});
