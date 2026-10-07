/**
 * POST /api/deals/bulk — move_stage síncrono (1–2 negócios): depois do loop o
 * board é avisado pelo helper (cache dos funis de origem e destino + um
 * `deal_moved` por card). Antes só invalidava o cache e o quadro dos outros
 * usuários esperava o polling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stageFindUnique: vi.fn(),
  dealFindMany: vi.fn(),
  dealUpdate: vi.fn(),
  syncBoardsAfterDealChanges: vi.fn(),
  invalidateBoardsForPipelines: vi.fn(),
  assertStageEntryFields: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) =>
    cb({ user: { id: "user_a", role: "ADMIN", organizationId: "org_1", isSuperAdmin: false } }),
}));
vi.mock("@/lib/authz", () => ({ loadAuthzContext: vi.fn(async () => ({})) }));
vi.mock("@/lib/authz/funnel-visibility", () => ({
  filterDealIdsByFunnel: vi.fn(async (_org: string, ids: string[]) => ids),
  funnelDealWhere: vi.fn(() => ({})),
}));
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePermissionForUser: vi.fn(async () => null),
  requirePipelineScope: vi.fn(async () => null),
  requireStageScope: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    stage: { findUnique: h.stageFindUnique },
    deal: { findMany: h.dealFindMany, update: h.dealUpdate },
  },
}));
vi.mock("@/lib/queue", () => ({
  LEADS_BULK_JOB_NAMES: { bulkMoveStage: "bulk-move-stage" },
  enqueueLeadsBulk: vi.fn(),
}));
vi.mock("@/lib/visibility", () => ({ getVisibilityFilter: vi.fn() }));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => undefined),
  notifyDealStageChanged: vi.fn(async () => undefined),
}));
vi.mock("@/services/kanban-filters", () => ({ parseAdvancedDealFilters: vi.fn() }));
vi.mock("@/services/deals", () => ({
  activeDealMovedSelect: { id: true },
  assertLostReasonAllowed: vi.fn(),
  assertStageEntryFields: h.assertStageEntryFields,
  assignDealOwner: vi.fn(),
  createDealEvent: vi.fn(async () => undefined),
  invalidateBoardsForPipelines: h.invalidateBoardsForPipelines,
  isValidDealStatus: () => true,
  markDealLost: vi.fn(),
  markDealWon: vi.fn(),
  resolveBoardDealIds: vi.fn(),
  syncBoardsAfterDealChanges: h.syncBoardsAfterDealChanges,
  StageFieldsRequiredError: class StageFieldsRequiredError extends Error {},
}));

import { POST } from "@/app/api/deals/bulk/route";

function call(body: Record<string, unknown>) {
  return POST(
    new Request("https://api.test/api/deals/bulk", { method: "POST", body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assertStageEntryFields.mockResolvedValue(undefined);
  h.syncBoardsAfterDealChanges.mockResolvedValue({ invalidatedPipelines: [], published: 0 });
  h.stageFindUnique.mockImplementation(async (args: { select?: { isWon?: boolean } }) =>
    args.select?.isWon
      ? { isWon: false, isLost: false }
      : { id: "s-dest", name: "Destino", pipelineId: "p-dest", pipeline: { id: "p-dest", name: "Funil" } },
  );
  h.dealFindMany.mockResolvedValue([
    {
      id: "d1",
      stageId: "s-a",
      status: "OPEN",
      contactId: "c1",
      stage: { name: "A", pipelineId: "p-orig", pipeline: { id: "p-orig", name: "Origem" } },
    },
    {
      id: "d2",
      stageId: "s-dest",
      status: "OPEN",
      contactId: "c2",
      stage: { name: "Destino", pipelineId: "p-dest", pipeline: { id: "p-dest", name: "Funil" } },
    },
  ]);
  h.dealUpdate.mockImplementation(async (args: { where: { id: string } }) => ({
    id: args.where.id,
    stageId: "s-dest",
    status: "OPEN",
    stage: { pipelineId: "p-dest", isWon: false, isLost: false },
  }));
});

describe("POST /api/deals/bulk — move_stage síncrono", () => {
  it("avisa o board uma vez: só o negócio que mudou de etapa, com a linha gravada e os dois funis", async () => {
    const res = await call({ action: "move_stage", dealIds: ["d1", "d2"], stageId: "s-dest" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ affected: 1, action: "move_stage" });
    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    const arg = h.syncBoardsAfterDealChanges.mock.calls[0]![0] as {
      changes: unknown[];
      rows: Map<string, { id: string }>;
      extraPipelineIds: string[];
    };
    expect(arg.changes).toEqual([{ dealId: "d1", fromStageId: "s-a", fromPipelineId: "p-orig" }]);
    expect(arg.rows.get("d1")).toMatchObject({ id: "d1", stageId: "s-dest" });
    expect(arg.extraPipelineIds).toEqual(["p-dest"]);
    // A invalidação agora é do helper (mesmo purge de antes, mais o evento).
    expect(h.invalidateBoardsForPipelines).not.toHaveBeenCalled();
    expect(h.syncBoardsAfterDealChanges.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.dealUpdate.mock.invocationCallOrder[0]!,
    );
  });

  it("nada mudou de etapa: não avisa o board", async () => {
    h.dealFindMany.mockResolvedValue([
      {
        id: "d2",
        stageId: "s-dest",
        status: "OPEN",
        contactId: "c2",
        stage: { name: "Destino", pipelineId: "p-dest", pipeline: { id: "p-dest", name: "Funil" } },
      },
    ]);

    const res = await call({ action: "move_stage", dealIds: ["d2"], stageId: "s-dest" });

    expect(res.status).toBe(200);
    expect(h.syncBoardsAfterDealChanges).not.toHaveBeenCalled();
  });
});
