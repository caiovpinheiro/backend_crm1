/**
 * BD-21: o boot do worker não pode mais disparar o `updateMany` de auto-cura
 * (filtro sem índice em `messages`). O módulo só loga.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMany } = vi.hoisted(() => ({
  updateMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { message: { updateMany } },
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  startStaleOutboundSweeper,
  stopStaleOutboundSweeper,
  sweepStaleOutbound,
} from "@/services/stale-outbound-sweeper";

beforeEach(() => {
  stopStaleOutboundSweeper();
  updateMany.mockClear();
});

describe("stale-outbound-sweeper", () => {
  it("boot não toca o banco (auto-cura removida)", async () => {
    startStaleOutboundSweeper();
    startStaleOutboundSweeper();
    await new Promise((r) => setImmediate(r));
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("sweepStaleOutbound continua no-op", async () => {
    await expect(sweepStaleOutbound(1000)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
