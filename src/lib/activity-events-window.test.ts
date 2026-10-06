import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { occurredAtWindow } from "@/lib/activity-events-window";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY_MS = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("occurredAtWindow", () => {
  it("sem piso: só o teto (agora + 1 dia) — descarta as partições futuras", () => {
    expect(occurredAtWindow()).toEqual({ lte: new Date(NOW.getTime() + DAY_MS) });
    expect(occurredAtWindow(null)).toEqual({ lte: new Date(NOW.getTime() + DAY_MS) });
  });

  it("com piso: 1 dia de folga para trás", () => {
    const opened = new Date("2026-09-10T08:00:00.000Z");
    expect(occurredAtWindow(opened)).toEqual({
      gte: new Date(opened.getTime() - DAY_MS),
      lte: new Date(NOW.getTime() + DAY_MS),
    });
  });

  it("data inválida não vira piso", () => {
    expect(occurredAtWindow(new Date("x"))).toEqual({ lte: new Date(NOW.getTime() + DAY_MS) });
  });
});
