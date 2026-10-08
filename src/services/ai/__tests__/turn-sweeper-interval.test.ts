/**
 * BD-12: o loop do sweeper anda a 3 s por padrão (era 1 s × 3 findMany × 2
 * processos) e a consulta de promoção usa (status, firstMessageAt).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn(async (_args?: unknown) => [] as unknown[]),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    conversationTurn: { findMany, updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("@/services/ai/turn-manager", () => ({
  claimTurn: vi.fn(),
  expireTurn: vi.fn(),
  isTurnExpired: () => false,
  requeueProcessingTurn: vi.fn(),
  isTurnManagerEnabled: () => true,
  isTurnDue: () => true,
  promoteTurnToReady: vi.fn(),
  runTurn: vi.fn(),
  turnMaxAttempts: () => 3,
  turnStaleMs: () => 60_000,
  TURN_DEBOUNCE_FLOOR_MS: 1000,
}));

import {
  DEFAULT_SWEEP_INTERVAL_MS,
  startAiTurnSweeper,
  stopAiTurnSweeper,
  sweepConversationTurns,
} from "@/services/ai/turn-sweeper";

beforeEach(() => {
  vi.useFakeTimers();
  findMany.mockClear();
  delete process.env.AI_TURN_SWEEP_INTERVAL_MS;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  stopAiTurnSweeper();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("turn-sweeper cadência", () => {
  it("padrão é 3 s: nada antes, um tick depois", async () => {
    expect(DEFAULT_SWEEP_INTERVAL_MS).toBe(3000);
    startAiTurnSweeper();
    await vi.advanceTimersByTimeAsync(2999);
    expect(findMany).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // 3 findMany por tick (stale, promoção, ready)
    expect(findMany).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(findMany).toHaveBeenCalledTimes(6);
  });

  it("consulta de promoção filtra por status + firstMessageAt", async () => {
    await sweepConversationTurns();
    const promoCall = findMany.mock.calls.find((c) => {
      const where = (c[0] as { where: Record<string, unknown> }).where;
      return "firstMessageAt" in where;
    });
    expect(promoCall).toBeDefined();
    const args = promoCall![0] as {
      where: { status: unknown; firstMessageAt: unknown };
      orderBy: unknown;
    };
    expect(args.where.status).toEqual({ in: ["RECEIVING", "STABILIZING"] });
    expect(args.orderBy).toEqual({ firstMessageAt: "asc" });
  });
});
