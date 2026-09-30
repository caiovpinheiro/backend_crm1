/**
 * Métricas de etapa do Kanban (banco falso, sem Redis): só deals OPEN
 * entram na agregação e o cache dura 300 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  return { queryRaw: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: h.queryRaw } }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({ $queryRaw: h.queryRaw }),
}));

import { runWithContext } from "@/lib/request-context";
import { getStageMetrics, STAGE_METRICS_TTL_SEC } from "@/services/analytics";

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId } as Parameters<typeof runWithContext>[0],
    fn,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  h.queryRaw.mockReset();
  h.queryRaw.mockResolvedValue([
    { stageId: "st-1", totalDeals: 4n, advancedDeals: 0n, avgDays: "2.5" },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getStageMetrics", () => {
  it("agrega só deals abertos do funil e da org", async () => {
    const rows = await withOrg("org-a", () => getStageMetrics("pipe-a"));

    expect(rows).toEqual([{ stageId: "st-1", conversionRate: 0, avgDaysInStage: 2.5 }]);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = h.queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain(`d.status = 'OPEN'::"DealStatus"`);
    expect(sql).not.toContain("'WON'");
    expect(sql).not.toContain('"closedAt"');
    expect(values).toEqual(["pipe-a", "org-a"]);
  });

  it("cache de 300 s por org + funil", async () => {
    expect(STAGE_METRICS_TTL_SEC).toBe(300);

    await withOrg("org-b", () => getStageMetrics("pipe-b"));
    await vi.advanceTimersByTimeAsync(299_000);
    await withOrg("org-b", () => getStageMetrics("pipe-b"));
    expect(h.queryRaw).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await withOrg("org-b", () => getStageMetrics("pipe-b"));
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });
});
