import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueDistributionDrain = vi.fn();
const getQueueCounts = vi.fn();
const conversationCount = vi.fn();
const conversationFindMany = vi.fn();
const findFirst = vi.fn();
const findManyResponsibles = vi.fn();
const getOrgIdOrNull = vi.fn();
const getDistributionResponsibles = vi.fn();
const hasOrganizationWidget = vi.fn();
const peekFruitless = vi.fn();

vi.mock("@/lib/distribution-drain-queue", () => ({
  enqueueDistributionDrain: (...a: unknown[]) => enqueueDistributionDrain(...a),
  isFreshDrainEnqueue: (r: string | null) => r === "added",
  allowInlineDistributionFallback: () => false,
}));

vi.mock("../queue", () => ({
  getQueueCounts: (...a: unknown[]) => getQueueCounts(...a),
}));

vi.mock("../engine", () => ({
  executeDistribution: vi.fn(),
}));

vi.mock("../responsibles", () => ({
  getDistributionResponsibles: (...a: unknown[]) =>
    getDistributionResponsibles(...a),
}));

vi.mock("@/services/organization-widgets", () => ({
  hasOrganizationWidget: (...a: unknown[]) => hasOrganizationWidget(...a),
}));

vi.mock("../pending-drain-store", () => ({
  peekPublishedFruitlessCooldown: (...a: unknown[]) => peekFruitless(...a),
  publishFruitlessCooldown: vi.fn(async () => {}),
  clearPublishedFruitlessCooldown: vi.fn(async () => {}),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      count: (...a: unknown[]) => conversationCount(...a),
      findMany: (...a: unknown[]) => conversationFindMany(...a),
    },
    distributionResponsible: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findManyResponsibles(...a),
    },
    distributionPending: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => getOrgIdOrNull(),
  runWithContext: async (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/services/ai/first-attendance", () => ({
  tryAssignFirstAttendanceAi: vi.fn(),
}));

vi.mock("@/services/ai/human-queue-policy", () => ({
  isHumanAttendanceWindowOpen: vi.fn(async () => true),
}));

describe("capacity_released producer vs worker", () => {
  beforeEach(() => {
    enqueueDistributionDrain.mockReset();
    getQueueCounts.mockReset();
    conversationCount.mockReset();
    conversationFindMany.mockReset();
    findFirst.mockReset();
    findManyResponsibles.mockReset();
    getOrgIdOrNull.mockReset();
    getDistributionResponsibles.mockReset();
    hasOrganizationWidget.mockReset();
    peekFruitless.mockReset();
    peekFruitless.mockResolvedValue(false);
    hasOrganizationWidget.mockResolvedValue(true);
  });

  it("producer enqueues without getQueueCounts or waiting COUNT", async () => {
    getOrgIdOrNull.mockReturnValue("org-producer");
    enqueueDistributionDrain.mockResolvedValue("added");

    const { enqueueProcessPendingOrRun } = await import("../pending");
    const result = await enqueueProcessPendingOrRun({
      trigger: "capacity_released",
      userId: "u1",
    });

    expect(enqueueDistributionDrain).toHaveBeenCalledWith({
      organizationId: "org-producer",
      trigger: "capacity_released",
      userId: "u1",
    });
    expect(result.skipReason).toBe("QUEUED");
    expect(getQueueCounts).not.toHaveBeenCalled();
    expect(conversationCount).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(findManyResponsibles).not.toHaveBeenCalled();
    expect(peekFruitless).not.toHaveBeenCalled();
  });

  it("producer logs only when the job is added, not when it already exists", async () => {
    getOrgIdOrNull.mockReturnValue("org-producer-log");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    enqueueDistributionDrain.mockResolvedValue("exists");
    const { enqueueProcessPendingOrRun } = await import("../pending");
    await enqueueProcessPendingOrRun({
      trigger: "capacity_released",
      userId: "u1",
    });
    expect(info).not.toHaveBeenCalled();

    enqueueDistributionDrain.mockResolvedValue("added");
    await enqueueProcessPendingOrRun({
      trigger: "capacity_released",
      userId: "u1",
    });
    expect(info).toHaveBeenCalledWith(
      "[distribution] drain enqueued",
      expect.stringContaining("org-producer-log"),
    );
    expect(info.mock.calls[0]?.[1]).not.toMatch(/pending/i);
    info.mockRestore();
  });

  it("worker skips drain when load >= queueLimit (no waiting-queue scan)", async () => {
    getOrgIdOrNull.mockReturnValue("org-worker-full");
    findFirst.mockResolvedValue({ queueLimit: 5 });
    getQueueCounts.mockResolvedValue(new Map([["u1", 5]]));

    const { processPendingDistributionQueue } = await import("../pending");
    const result = await processPendingDistributionQueue({
      trigger: "capacity_released",
      userId: "u1",
    });

    expect(result.skipReason).toBe("AT_CAPACITY");
    expect(result.pending).toBe(0);
    expect(getQueueCounts).toHaveBeenCalledWith(["u1"]);
    expect(conversationCount).not.toHaveBeenCalled();
    expect(conversationFindMany).not.toHaveBeenCalled();
    expect(getDistributionResponsibles).not.toHaveBeenCalled();
  });

  it("worker proceeds past the volume gate when load < queueLimit", async () => {
    getOrgIdOrNull.mockReturnValue("org-worker-slot");
    findFirst.mockResolvedValue({ queueLimit: 5 });
    getQueueCounts.mockResolvedValue(new Map([["u1", 2]]));
    hasOrganizationWidget.mockResolvedValue(false);

    const { processPendingDistributionQueue } = await import("../pending");
    const result = await processPendingDistributionQueue({
      trigger: "capacity_released",
      userId: "u1",
    });

    expect(result.skipReason).not.toBe("AT_CAPACITY");
    expect(hasOrganizationWidget).toHaveBeenCalled();
    expect(getDistributionResponsibles).not.toHaveBeenCalled();
  });
});
