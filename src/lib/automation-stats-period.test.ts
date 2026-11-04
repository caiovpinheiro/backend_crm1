import { describe, expect, it } from "vitest";

import { parseStatsPeriod, statsPeriodRange, statsPeriodWhere } from "./automation-stats-period";

describe("statsPeriodRange (Brasília, UTC-3)", () => {
  it("hoje às 22h BRT (01h UTC do dia seguinte) continua sendo hoje", () => {
    const now = new Date("2026-11-05T01:00:00.000Z"); // 04/11 22:00 BRT
    expect(statsPeriodRange("today", now)).toEqual({
      gte: new Date("2026-11-04T03:00:00.000Z"),
      lt: new Date("2026-11-05T03:00:00.000Z"),
    });
  });

  it("ontem é o dia BRT anterior inteiro", () => {
    const now = new Date("2026-11-04T12:00:00.000Z");
    expect(statsPeriodRange("yesterday", now)).toEqual({
      gte: new Date("2026-11-03T03:00:00.000Z"),
      lt: new Date("2026-11-04T03:00:00.000Z"),
    });
  });

  it("7 dias = hoje + 6 anteriores", () => {
    const now = new Date("2026-11-04T12:00:00.000Z");
    const r = statsPeriodRange("7d", now);
    expect(r.gte).toEqual(new Date("2026-10-29T03:00:00.000Z"));
    expect(r.lt).toEqual(new Date("2026-11-05T03:00:00.000Z"));
  });

  it("valor desconhecido não filtra", () => {
    expect(parseStatsPeriod("semana")).toBeNull();
    expect(statsPeriodWhere(undefined)).toEqual({});
    expect(statsPeriodWhere("TODAY").executedAt).toBeDefined();
  });
});
