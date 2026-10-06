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
  mocks.fireTrigger.mockResolvedValue(undefined);
});

describe("processBulkMoveStage — cache do board", () => {
  it("invalida os pipelines de origem e destino depois do updateMany", async () => {
    mocks.dealFindMany.mockResolvedValue([
      { id: "d1", stageId: "s-a", status: "OPEN", contactId: "c1", stage: { name: "A", pipelineId: "p-orig" } },
      { id: "d2", stageId: "s-b", status: "OPEN", contactId: "c2", stage: { name: "B", pipelineId: "p-dest" } },
      { id: "d3", stageId: "s-dest", status: "OPEN", contactId: "c3", stage: { name: "Destino", pipelineId: "p-dest" } },
    ]);

    await run({ dealIds: ["d1", "d2", "d3"] });

    expect(mocks.dealUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateBoardsForPipelines).toHaveBeenCalledTimes(1);
    const [ids] = mocks.invalidateBoardsForPipelines.mock.calls[0] as [string[]];
    expect(new Set(ids)).toEqual(new Set(["p-dest", "p-orig"]));
    // Purga sai depois da escrita e antes de marcar a operação concluída.
    const updateOrder = mocks.dealUpdateMany.mock.invocationCallOrder[0]!;
    const invalidateOrder = mocks.invalidateBoardsForPipelines.mock.invocationCallOrder[0]!;
    const finishedOrder = mocks.markOperationFinished.mock.invocationCallOrder[0]!;
    expect(invalidateOrder).toBeGreaterThan(updateOrder);
    expect(invalidateOrder).toBeLessThan(finishedOrder);
  });

  it("não invalida quando nenhum deal muda de etapa", async () => {
    mocks.dealFindMany.mockResolvedValue([
      { id: "d3", stageId: "s-dest", status: "OPEN", contactId: "c3", stage: { name: "Destino", pipelineId: "p-dest" } },
    ]);

    await run({ dealIds: ["d3"] });

    expect(mocks.dealUpdateMany).not.toHaveBeenCalled();
    expect(mocks.invalidateBoardsForPipelines).not.toHaveBeenCalled();
    expect(mocks.markOperationFinished).toHaveBeenCalledTimes(1);
  });

  it("não publica deal_moved — lote fica fora do realtime visual", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const job = readFileSync(join(here, "bulk-move-stage.job.ts"), "utf8");
    const route = readFileSync(
      join(here, "../../app/api/deals/bulk/route.ts"),
      "utf8",
    );
    for (const source of [job, route]) {
      expect(source).not.toMatch(/publishDealMoved\s*\(/);
      expect(source).not.toMatch(/publishActiveDealMoved\s*\(/);
      expect(source).not.toMatch(/sseBus\s*\.\s*publish\s*\(/);
    }
  });
});
