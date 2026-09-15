import { describe, expect, it } from "vitest";

import { selectResponsible } from "../engine";
import type { DistributionResponsibleView } from "../responsibles";

function agent(
  userId: string,
  volume: number,
  queueCount = 99,
): DistributionResponsibleView {
  return {
    userId,
    name: userId,
    email: null,
    avatarUrl: null,
    role: "AGENT",
    participates: true,
    visibleInCoverage: true,
    queueLimit: 0,
    volume,
    type: null,
    paused: false,
    preLunchStopMinutes: 30,
    lastExecutionAt: "2026-01-01T00:00:00.000Z",
    departments: [],
    status: "ONLINE",
    hasSchedule: false,
    schedule: null,
    queueCount,
    totalQueueCount: queueCount,
    eligible: true,
    blockedReasons: [],
  } as DistributionResponsibleView;
}

describe("selectResponsible (sorteio por peso)", () => {
  it("peso 5 vs 1: bilhetes 0–4 vão para A, 5 para B — ignora fila", () => {
    const a = agent("A", 5, 0);
    const b = agent("B", 1, 80);
    const pot = [a, b];

    expect(selectResponsible(pot, () => 0).userId).toBe("A");
    expect(selectResponsible(pot, () => 4.999 / 6).userId).toBe("A");
    expect(selectResponsible(pot, () => 5 / 6).userId).toBe("B");
    expect(selectResponsible(pot, () => 0.999).userId).toBe("B");
  });

  it("pesos iguais: cada um tem 1 bilhete", () => {
    const pot = [agent("A", 1), agent("B", 1), agent("C", 1)];
    expect(selectResponsible(pot, () => 0).userId).toBe("A");
    expect(selectResponsible(pot, () => 1 / 3).userId).toBe("B");
    expect(selectResponsible(pot, () => 2 / 3).userId).toBe("C");
  });

  it("peso 0 não entra; se todos 0, sorteio uniforme", () => {
    const pot = [agent("A", 0), agent("B", 3)];
    expect(selectResponsible(pot, () => 0).userId).toBe("B");
    expect(selectResponsible([agent("A", 0), agent("B", 0)], () => 0.6).userId).toBe(
      "B",
    );
  });
});
