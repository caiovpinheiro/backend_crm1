import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BulkMarkStatusPayload } from "@/lib/queue";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  markDealWon: vi.fn(),
  markDealLost: vi.fn(),
  createDealEventsMany: vi.fn(),
  fireTrigger: vi.fn(),
  notifyDealStageChanged: vi.fn(),
  incrementOperationProgress: vi.fn(),
  markOperationFinished: vi.fn(),
  markOperationStarted: vi.fn(),
  markOperationFailed: vi.fn(),
  isOperationCancelled: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { deal: { findMany: mocks.findMany } },
}));
vi.mock("@/services/deals", () => ({
  markDealWon: mocks.markDealWon,
  markDealLost: mocks.markDealLost,
  createDealEventsMany: mocks.createDealEventsMany,
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: mocks.fireTrigger,
  notifyDealStageChanged: mocks.notifyDealStageChanged,
}));
vi.mock("./_update-progress", () => ({
  incrementOperationProgress: mocks.incrementOperationProgress,
  markOperationFinished: mocks.markOperationFinished,
  markOperationStarted: mocks.markOperationStarted,
  markOperationFailed: mocks.markOperationFailed,
  isOperationCancelled: mocks.isOperationCancelled,
  truncateErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

import { processBulkMarkStatus } from "./bulk-mark-status.job";

function run(payload: Partial<BulkMarkStatusPayload>) {
  const full: BulkMarkStatusPayload = {
    operationId: "op1",
    organizationId: "org1",
    initiatedByUserId: "u1",
    dealIds: [],
    status: "LOST",
    ...payload,
  };
  return processBulkMarkStatus(full, { id: "j1", attemptsMade: 0 } as Job<BulkMarkStatusPayload>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isOperationCancelled.mockResolvedValue(false);
  mocks.createDealEventsMany.mockResolvedValue(undefined);
  mocks.fireTrigger.mockResolvedValue(undefined);
  mocks.notifyDealStageChanged.mockResolvedValue(undefined);
});

describe("processBulkMarkStatus", () => {
  it("marca perdido, pula quem já está no status e registra deal inexistente como falha", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "d1", status: "OPEN", stageId: "s1" },
      { id: "d2", status: "LOST", stageId: "lost" },
    ]);
    mocks.markDealLost.mockResolvedValue({ stageId: "lost" });

    await run({ dealIds: ["d1", "d2", "d3"], lostReason: "Sem interesse" });

    expect(mocks.markDealLost).toHaveBeenCalledTimes(1);
    expect(mocks.markDealLost).toHaveBeenCalledWith("d1", "Sem interesse");
    expect(mocks.createDealEventsMany).toHaveBeenCalledWith([
      expect.objectContaining({ dealId: "d1", type: "STATUS_CHANGED" }),
    ]);
    expect(mocks.fireTrigger).toHaveBeenCalledWith(
      "deal_lost",
      expect.objectContaining({ dealId: "d1" }),
    );
    expect(mocks.notifyDealStageChanged).toHaveBeenCalledWith("d1", "s1", "lost");
    expect(mocks.incrementOperationProgress).toHaveBeenCalledWith(
      "op1",
      "org1",
      { processed: 3, succeeded: 2, failed: 1 },
      [expect.objectContaining({ itemId: "d3" })],
    );
    expect(mocks.markOperationFinished).toHaveBeenCalledWith("op1", "org1");
  });

  it("erro em um deal não derruba o chunk", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "d1", status: "OPEN", stageId: "s1" },
      { id: "d2", status: "OPEN", stageId: "s1" },
    ]);
    mocks.markDealWon
      .mockRejectedValueOnce(new Error("NOT_FOUND"))
      .mockResolvedValueOnce({ stageId: "won" });

    await run({ dealIds: ["d1", "d2"], status: "WON" });

    expect(mocks.markDealWon).toHaveBeenCalledTimes(2);
    expect(mocks.incrementOperationProgress).toHaveBeenCalledWith(
      "op1",
      "org1",
      { processed: 2, succeeded: 1, failed: 1 },
      [expect.objectContaining({ itemId: "d1", message: "NOT_FOUND" })],
    );
  });

  it("para quando a operação é cancelada", async () => {
    mocks.isOperationCancelled.mockResolvedValue(true);

    await run({ dealIds: ["d1"] });

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.markOperationFinished).not.toHaveBeenCalled();
  });
});
