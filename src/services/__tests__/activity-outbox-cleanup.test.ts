/**
 * Projetor da outbox de tabulação: a limpeza das linhas processadas
 * (`cleanupActivityOutbox`) roda no primeiro tick e depois 1x/dia; falha
 * da limpeza não derruba a projeção. Banco falso, sem Redis.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { $queryRaw: h.queryRaw, $executeRaw: h.executeRaw },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/activity-log", () => ({
  runLogEvent: vi.fn(),
  userIdForFk: vi.fn(),
}));
vi.mock("@/lib/metrics", () => ({
  metrics: { activityOutbox: { processed: { inc: vi.fn() } } },
}));

import {
  OUTBOX_CLEANUP_INTERVAL_MS,
  resetTabulationProjectorForTests,
  runTabulationProjectorTick,
} from "@/services/activity-outbox";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");

function cleanupSql(): string {
  const call = h.executeRaw.mock.calls.at(-1) as [TemplateStringsArray, ...unknown[]];
  return call[0].join("?");
}

beforeEach(() => {
  h.queryRaw.mockReset();
  h.executeRaw.mockReset();
  h.queryRaw.mockResolvedValue([]);
  h.executeRaw.mockResolvedValue(3);
  resetTabulationProjectorForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runTabulationProjectorTick: limpeza da outbox", () => {
  it("limpa no primeiro tick e só de novo depois de 24 h", async () => {
    expect(OUTBOX_CLEANUP_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);

    expect(await runTabulationProjectorTick(T0)).toEqual({ projected: 0, cleaned: 3 });
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    expect(cleanupSql()).toContain('DELETE FROM "activity_outbox"');
    expect(cleanupSql()).toContain('"processedAt" IS NOT NULL');

    // Ticks de 5 s ao longo do dia: só projeção.
    for (let i = 1; i <= 3; i++) {
      expect(await runTabulationProjectorTick(T0 + i * 5_000)).toEqual({
        projected: 0,
        cleaned: null,
      });
    }
    await runTabulationProjectorTick(T0 + OUTBOX_CLEANUP_INTERVAL_MS - 1);
    expect(h.executeRaw).toHaveBeenCalledTimes(1);

    await runTabulationProjectorTick(T0 + OUTBOX_CLEANUP_INTERVAL_MS);
    expect(h.executeRaw).toHaveBeenCalledTimes(2);
  });

  it("a projeção continua quando a limpeza falha, e a próxima tentativa é no dia seguinte", async () => {
    h.executeRaw.mockRejectedValueOnce(new Error("lock timeout"));

    expect(await runTabulationProjectorTick(T0)).toEqual({ projected: 0, cleaned: null });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);

    await runTabulationProjectorTick(T0 + 5_000);
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("a projeção roda em todo tick, com a consulta pelas linhas pendentes", async () => {
    await runTabulationProjectorTick(T0);
    const [strings] = h.queryRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join("?");
    expect(sql).toContain('"processedAt" IS NULL');
    expect(sql).toContain('"deadLetterAt" IS NULL');
    expect(sql).toContain('"scheduledFor" <= CURRENT_TIMESTAMP');
  });
});
