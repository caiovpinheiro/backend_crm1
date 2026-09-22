import { beforeEach, describe, expect, it, vi } from "vitest";

import { consultantHasFreeSlot } from "../pending-drain-guard";
import { decideCapacityReleasedDrain } from "../capacity-released-gate";

const getQueueCounts = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();
const getOrgIdOrNull = vi.fn();

vi.mock("../queue", () => ({
  getQueueCounts: (...a: unknown[]) => getQueueCounts(...a),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    distributionResponsible: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => getOrgIdOrNull(),
}));

describe("capacity released gate (worker)", () => {
  beforeEach(() => {
    getQueueCounts.mockReset();
    findFirst.mockReset();
    findMany.mockReset();
    getOrgIdOrNull.mockReset();
  });

  it("queueLimit 0 never has a slot; load >= limit is full", () => {
    expect(consultantHasFreeSlot(0, 0)).toBe(false);
    expect(consultantHasFreeSlot(3, 5)).toBe(true);
    expect(consultantHasFreeSlot(5, 5)).toBe(false);
    expect(consultantHasFreeSlot(6, 5)).toBe(false);
  });

  it("at-capacity → skip drain; below volume → drain", () => {
    expect(
      decideCapacityReleasedDrain({
        snapshots: [{ userId: "u1", queueLimit: 5, queueCount: 5 }],
      }),
    ).toBe("skip_at_capacity");
    expect(
      decideCapacityReleasedDrain({
        snapshots: [{ userId: "u1", queueLimit: 5, queueCount: 4 }],
      }),
    ).toBe("drain");
  });

  it("org-wide drain if any consultant has a slot", () => {
    expect(
      decideCapacityReleasedDrain({
        snapshots: [
          { userId: "a", queueLimit: 5, queueCount: 5 },
          { userId: "b", queueLimit: 8, queueCount: 3 },
        ],
      }),
    ).toBe("drain");
  });

  it("evaluate: at-capacity does not proceed", async () => {
    getOrgIdOrNull.mockReturnValue("org1");
    findFirst.mockResolvedValue({ queueLimit: 4 });
    getQueueCounts.mockResolvedValue(new Map([["u1", 4]]));

    const { evaluateCapacityReleasedDrain } = await import(
      "../capacity-released-gate"
    );
    const result = await evaluateCapacityReleasedDrain({ userId: "u1" });
    expect(result).toEqual({
      proceed: false,
      reason: "at_capacity",
      load: 4,
      volume: 4,
    });
  });

  it("evaluate: below volume proceeds", async () => {
    getOrgIdOrNull.mockReturnValue("org1");
    findFirst.mockResolvedValue({ queueLimit: 4 });
    getQueueCounts.mockResolvedValue(new Map([["u1", 2]]));

    const { evaluateCapacityReleasedDrain } = await import(
      "../capacity-released-gate"
    );
    const result = await evaluateCapacityReleasedDrain({ userId: "u1" });
    expect(result).toEqual({
      proceed: true,
      reason: "has_slot",
      load: 2,
      volume: 4,
    });
  });

  it("evaluate: loads queueLimit + getQueueCounts (no waiting COUNT)", async () => {
    getOrgIdOrNull.mockReturnValue("org1");
    findFirst.mockResolvedValue({ queueLimit: 10 });
    getQueueCounts.mockResolvedValue(new Map([["u1", 1]]));

    const { evaluateCapacityReleasedDrain } = await import(
      "../capacity-released-gate"
    );
    await evaluateCapacityReleasedDrain({ userId: "u1" });
    expect(findFirst).toHaveBeenCalled();
    expect(getQueueCounts).toHaveBeenCalledWith(["u1"]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
