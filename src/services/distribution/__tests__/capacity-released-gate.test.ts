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

  it("sem teto: sempre tem vaga", () => {
    expect(consultantHasFreeSlot(0, 0)).toBe(true);
    expect(consultantHasFreeSlot(5, 5)).toBe(true);
    expect(consultantHasFreeSlot(80, 1)).toBe(true);
  });

  it("carga alta não barra a drenagem", () => {
    expect(
      decideCapacityReleasedDrain({
        snapshots: [{ userId: "u1", queueLimit: 5, queueCount: 5 }],
      }),
    ).toBe("drain");
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

  it("evaluate: carga no teto antigo ainda drena", async () => {
    getOrgIdOrNull.mockReturnValue("org1");
    findFirst.mockResolvedValue({ queueLimit: 4 });
    getQueueCounts.mockResolvedValue(new Map([["u1", 4]]));

    const { evaluateCapacityReleasedDrain } = await import(
      "../capacity-released-gate"
    );
    const result = await evaluateCapacityReleasedDrain({ userId: "u1" });
    expect(result).toEqual({
      proceed: true,
      reason: "has_slot",
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
