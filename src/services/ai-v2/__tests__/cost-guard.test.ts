import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { aISimpleTurnLog: { aggregate } } }));

import { checkV2CostCap, estimateV2Cost, startOfPeriod } from "../cost-guard";

const base = { model: "gpt-4o-mini", businessHours: { timezone: "America/Sao_Paulo" } };
const run = (config: Record<string, unknown>, now = new Date("2026-09-27T15:00:00Z")) =>
  checkV2CostCap({ config: { ...base, ...config } as never, agentId: "a-1", organizationId: "o-1", inputTokens: 0, outputTokens: 0, now });

describe("teto de gasto do agente", () => {
  beforeEach(() => aggregate.mockReset());

  it("sem teto configurado não consulta nada", async () => {
    await expect(run({})).resolves.toEqual({ allowed: true });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("teto diário em US$ barra quando o gasto do dia passa", async () => {
    // 10M de entrada no gpt-4o-mini = US$ 1,50
    aggregate.mockResolvedValue({ _sum: { inputTokens: 10_000_000, outputTokens: 0 } });
    const r = await run({ costCap: { maxUsdPerDay: 1, maxUsdPerMonth: 0 } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("diário");
    await expect(run({ costCap: { maxUsdPerDay: 2, maxUsdPerMonth: 0 } })).resolves.toEqual({ allowed: true });
  });

  it("teto mensal em US$ usa o acumulado desde o início do mês", async () => {
    aggregate.mockResolvedValue({ _sum: { inputTokens: 100_000_000, outputTokens: 0 } });
    const r = await run({ costCap: { maxUsdPerDay: 0, maxUsdPerMonth: 10 } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("mensal");
    const since = aggregate.mock.calls[0][0].where.createdAt.gte as Date;
    expect(since.toISOString()).toBe("2026-09-01T03:00:00.000Z");
  });

  it("dia e mês começam no fuso do agente", () => {
    const now = new Date("2026-09-27T01:30:00Z"); // 26/09 22:30 em São Paulo
    expect(startOfPeriod("day", "America/Sao_Paulo", now).toISOString()).toBe("2026-09-26T03:00:00.000Z");
    expect(startOfPeriod("month", "America/Sao_Paulo", now).toISOString()).toBe("2026-09-01T03:00:00.000Z");
  });

  it("custo pelo preço do modelo", () => {
    expect(estimateV2Cost("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.75, 5);
  });
});
