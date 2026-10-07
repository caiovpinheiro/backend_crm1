import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BulkMoveStagePayload } from "@/lib/queue";

const mocks = vi.hoisted(() => ({
  stageFindUnique: vi.fn(),
  dealFindMany: vi.fn(),
  dealUpdateMany: vi.fn(),
  assertStageEntryFields: vi.fn(),
  createDealEventsMany: vi.fn(),
  invalidateBoardsForPipelines: vi.fn(),
  syncBoardsAfterDealChanges: vi.fn(),
  fireTrigger: vi.fn(),
  incrementOperationProgress: vi.fn(),
  markOperationFinished: vi.fn(),
  markOperationStarted: vi.fn(),
  markOperationFailed: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    stage: { findUnique: mocks.stageFindUnique },
    deal: { findMany: mocks.dealFindMany, updateMany: mocks.dealUpdateMany },
  },
}));
vi.mock("@/services/deals", () => ({
  assertStageEntryFields: mocks.assertStageEntryFields,
  createDealEventsMany: mocks.createDealEventsMany,
  invalidateBoardsForPipelines: mocks.invalidateBoardsForPipelines,
  syncBoardsAfterDealChanges: mocks.syncBoardsAfterDealChanges,
  DEAL_MOVED_BATCH_LIMIT: 50,
  StageFieldsRequiredError: class StageFieldsRequiredError extends Error {},
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: mocks.fireTrigger,
}));
vi.mock("./_update-progress", () => ({
  incrementOperationProgress: mocks.incrementOperationProgress,
  markOperationFinished: mocks.markOperationFinished,
  markOperationStarted: mocks.markOperationStarted,
  markOperationFailed: mocks.markOperationFailed,
  truncateErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

import { processBulkMoveStage } from "./bulk-move-stage.job";

function run(payload: Partial<BulkMoveStagePayload>) {
  const full: BulkMoveStagePayload = {
    operationId: "op1",
    organizationId: "org1",
    initiatedByUserId: "u1",
    dealIds: [],
    targetStageId: "s-dest",
    ...payload,
  };
  return processBulkMoveStage(full, { id: "j1", attemptsMade: 0 } as Job<BulkMoveStagePayload>);
}

/** `n` negócios em `s-a` (funil `p-orig`), que o `findMany` devolve por chunk. */
function seedManyDeals(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `d${i}`);
  mocks.dealFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({
      id,
      stageId: "s-a",
      status: "OPEN",
      contactId: "c",
      stage: { name: "A", pipelineId: "p-orig" },
    })),
  );
  return ids;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stageFindUnique.mockResolvedValue({
    id: "s-dest",
    name: "Destino",
    isWon: false,
    isLost: false,
    pipelineId: "p-dest",
  });
  mocks.dealUpdateMany.mockResolvedValue({ count: 0 });
  mocks.assertStageEntryFields.mockResolvedValue(undefined);
  mocks.createDealEventsMany.mockResolvedValue(undefined);
  mocks.invalidateBoardsForPipelines.mockResolvedValue(undefined);
  mocks.syncBoardsAfterDealChanges.mockResolvedValue({ invalidatedPipelines: [], published: 0 });
  mocks.fireTrigger.mockResolvedValue(undefined);
});

describe("processBulkMoveStage — cache e realtime do board", () => {
  it("lote pequeno: invalida origem e destino e publica um deal_moved por card (via helper), depois do updateMany", async () => {
    mocks.dealFindMany.mockResolvedValue([
      { id: "d1", stageId: "s-a", status: "OPEN", contactId: "c1", stage: { name: "A", pipelineId: "p-orig" } },
      { id: "d2", stageId: "s-b", status: "OPEN", contactId: "c2", stage: { name: "B", pipelineId: "p-dest" } },
      { id: "d3", stageId: "s-dest", status: "OPEN", contactId: "c3", stage: { name: "Destino", pipelineId: "p-dest" } },
    ]);

    await run({ dealIds: ["d1", "d2", "d3"] });

    expect(mocks.dealUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    const arg = mocks.syncBoardsAfterDealChanges.mock.calls[0]![0] as {
      orgId: string;
      changes: Array<{ dealId: string; fromStageId: string; fromPipelineId: string }>;
      extraPipelineIds: Iterable<string>;
    };
    expect(arg.orgId).toBe("org1");
    // d3 já estava no destino: não entra.
    expect(arg.changes).toEqual([
      { dealId: "d1", fromStageId: "s-a", fromPipelineId: "p-orig" },
      { dealId: "d2", fromStageId: "s-b", fromPipelineId: "p-dest" },
    ]);
    expect(new Set(arg.extraPipelineIds)).toEqual(new Set(["p-dest", "p-orig"]));
    // O helper cuida da invalidação junto com o evento.
    expect(mocks.invalidateBoardsForPipelines).not.toHaveBeenCalled();
    // Purga/evento saem depois da escrita e antes de marcar a operação concluída.
    const updateOrder = mocks.dealUpdateMany.mock.invocationCallOrder[0]!;
    const syncOrder = mocks.syncBoardsAfterDealChanges.mock.invocationCallOrder[0]!;
    const finishedOrder = mocks.markOperationFinished.mock.invocationCallOrder[0]!;
    expect(syncOrder).toBeGreaterThan(updateOrder);
    expect(syncOrder).toBeLessThan(finishedOrder);
  });

  it("exatamente 50 movidos ainda publica por card", async () => {
    await run({ dealIds: seedManyDeals(50) });

    expect(mocks.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(
      (mocks.syncBoardsAfterDealChanges.mock.calls[0]![0] as { changes: unknown[] }).changes,
    ).toHaveLength(50);
    expect(mocks.invalidateBoardsForPipelines).not.toHaveBeenCalled();
  });

  it("lote grande (51 movidos, dois chunks): só invalida o board, sem evento por card", async () => {
    await run({ dealIds: seedManyDeals(51) });

    expect(mocks.syncBoardsAfterDealChanges).not.toHaveBeenCalled();
    expect(mocks.invalidateBoardsForPipelines).toHaveBeenCalledTimes(1);
    const [pipes] = mocks.invalidateBoardsForPipelines.mock.calls[0] as [string[]];
    expect(new Set(pipes)).toEqual(new Set(["p-dest", "p-orig"]));
    const updateOrder = mocks.dealUpdateMany.mock.invocationCallOrder.at(-1)!;
    const invalidateOrder = mocks.invalidateBoardsForPipelines.mock.invocationCallOrder[0]!;
    const finishedOrder = mocks.markOperationFinished.mock.invocationCallOrder[0]!;
    expect(invalidateOrder).toBeGreaterThan(updateOrder);
    expect(invalidateOrder).toBeLessThan(finishedOrder);
  });

  it("não invalida nem publica quando nenhum deal muda de etapa", async () => {
    mocks.dealFindMany.mockResolvedValue([
      { id: "d3", stageId: "s-dest", status: "OPEN", contactId: "c3", stage: { name: "Destino", pipelineId: "p-dest" } },
    ]);

    await run({ dealIds: ["d3"] });

    expect(mocks.dealUpdateMany).not.toHaveBeenCalled();
    expect(mocks.invalidateBoardsForPipelines).not.toHaveBeenCalled();
    expect(mocks.syncBoardsAfterDealChanges).not.toHaveBeenCalled();
    expect(mocks.markOperationFinished).toHaveBeenCalledTimes(1);
  });

  it("não fala com o barramento direto — o evento sai pelo helper tipado de services/deals", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const job = readFileSync(join(here, "bulk-move-stage.job.ts"), "utf8");
    const route = readFileSync(
      join(here, "../../app/api/deals/bulk/route.ts"),
      "utf8",
    );
    for (const source of [job, route]) {
      expect(source).not.toMatch(/publishDealMoved\s*\(/);
      expect(source).not.toMatch(/sseBus\s*\.\s*publish\s*\(/);
    }
  });
});
