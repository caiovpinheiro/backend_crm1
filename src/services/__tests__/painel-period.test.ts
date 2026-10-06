import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUSINESS_HOURS,
  PAINEL_MAX_RANGE_MS,
  businessMsBetween,
  clampRangeFromEnd,
  computePainelRange,
  dayKeyFromDate,
  parseDay,
  startOfZonedDay,
  zonedParts,
  type BusinessHours,
} from "@/services/painel-period";

const HOUR = 60 * 60_000;
// Hora de São Paulo (UTC-3) como instante.
const sp = (iso: string) => new Date(`${iso}-03:00`);

describe("businessMsBetween", () => {
  it("conta só a janela comercial no mesmo dia", () => {
    // Terça 06/10/2026, 10:00 → 11:30
    expect(businessMsBetween(sp("2026-10-06T10:00:00"), sp("2026-10-06T11:30:00"))).toBe(1.5 * HOUR);
  });

  it("corta antes da abertura e depois do fechamento", () => {
    expect(businessMsBetween(sp("2026-10-06T08:00:00"), sp("2026-10-06T19:00:00"))).toBe(9 * HOUR);
  });

  it("atravessa a noite sem contar o intervalo fechado", () => {
    // Terça 17:00 → quarta 10:00 = 1h (terça) + 1h (quarta)
    expect(businessMsBetween(sp("2026-10-06T17:00:00"), sp("2026-10-07T10:00:00"))).toBe(2 * HOUR);
  });

  it("pula o fim de semana", () => {
    // Sexta 17:00 → segunda 10:00
    expect(businessMsBetween(sp("2026-10-09T17:00:00"), sp("2026-10-12T10:00:00"))).toBe(2 * HOUR);
    // Só sábado e domingo
    expect(businessMsBetween(sp("2026-10-10T09:00:00"), sp("2026-10-11T18:00:00"))).toBe(0);
  });

  it("devolve 0 quando o fim não é depois do início", () => {
    const t = sp("2026-10-06T10:00:00");
    expect(businessMsBetween(t, t)).toBe(0);
    expect(businessMsBetween(sp("2026-10-06T11:00:00"), t)).toBe(0);
  });

  it("respeita horário e dias da semana configurados", () => {
    const bh: BusinessHours = { startMin: 8 * 60, endMin: 12 * 60, weekdays: [6] };
    // Sábado 10/10/2026 das 8h às 12h conta; sexta não.
    expect(businessMsBetween(sp("2026-10-09T00:00:00"), sp("2026-10-11T00:00:00"), bh)).toBe(4 * HOUR);
  });

  it("usa o dia civil de SP, não o do UTC (23:30 em SP já é o dia seguinte em UTC)", () => {
    // Terça 23:30 SP = quarta 02:30 UTC. Fora do horário comercial: 0.
    expect(businessMsBetween(sp("2026-10-06T23:30:00"), sp("2026-10-07T08:30:00"))).toBe(0);
    // Terça 23:30 SP → quarta 09:30 SP: 30 min de quarta.
    expect(businessMsBetween(sp("2026-10-06T23:30:00"), sp("2026-10-07T09:30:00"))).toBe(0.5 * HOUR);
  });

  // Implementação anterior (um Intl.DateTimeFormat por dia). A nova tem que dar
  // exatamente o mesmo número.
  function reference(from: Date, to: Date, bh: BusinessHours): number {
    if (to.getTime() <= from.getTime()) return 0;
    let ms = 0;
    const cursor = startOfZonedDay(from);
    const endDay = startOfZonedDay(to);
    let guard = 0;
    while (cursor.getTime() <= endDay.getTime() && guard < 800) {
      const parts = zonedParts(cursor);
      if (bh.weekdays.includes(parts.weekday)) {
        const dayKey = dayKeyFromDate(cursor);
        const winStart = parseDay(dayKey, false)!;
        winStart.setMinutes(winStart.getMinutes() + bh.startMin);
        const winEnd = parseDay(dayKey, false)!;
        winEnd.setMinutes(winEnd.getMinutes() + bh.endMin);
        const a = from.getTime() > winStart.getTime() ? from : winStart;
        const b = to.getTime() < winEnd.getTime() ? to : winEnd;
        if (b.getTime() > a.getTime()) ms += b.getTime() - a.getTime();
      }
      cursor.setDate(cursor.getDate() + 1);
      guard++;
    }
    return ms;
  }

  it("dá o mesmo resultado da implementação anterior em casos variados", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const base = Date.UTC(2026, 0, 1);
    const configs: BusinessHours[] = [
      DEFAULT_BUSINESS_HOURS,
      { startMin: 8 * 60 + 30, endMin: 12 * 60, weekdays: [0, 6] },
      { startMin: 0, endMin: 24 * 60 - 1, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ];
    for (let i = 0; i < 300; i++) {
      const from = new Date(base + Math.floor(rnd() * 300 * 24 * HOUR));
      const to = new Date(from.getTime() + Math.floor(rnd() * 20 * 24 * HOUR) - HOUR);
      const bh = configs[i % configs.length];
      expect(businessMsBetween(from, to, bh)).toBe(reference(from, to, bh));
    }
  });
});

describe("computePainelRange", () => {
  // Terça 06/10/2026, 12:00 em SP (15:00 UTC).
  const now = new Date("2026-10-06T15:00:00.000Z");
  const iso = (r: { from: Date; to: Date }) => [r.from.toISOString(), r.to.toISOString()];

  it("hoje (padrão e explícito) vai da meia-noite ao fim do dia em SP", () => {
    const today = ["2026-10-06T03:00:00.000Z", "2026-10-07T02:59:59.999Z"];
    expect(iso(computePainelRange(null, null, null, now))).toEqual(today);
    expect(iso(computePainelRange("today", null, null, now))).toEqual(today);
    expect(iso(computePainelRange("qualquer-coisa", null, null, now))).toEqual(today);
  });

  it("last_7 inclui hoje e os 6 dias anteriores", () => {
    expect(iso(computePainelRange("last_7", null, null, now))).toEqual([
      "2026-09-30T03:00:00.000Z",
      "2026-10-07T02:59:59.999Z",
    ]);
  });

  it("last_30 inclui hoje e os 29 dias anteriores", () => {
    expect(iso(computePainelRange("last_30", null, null, now))).toEqual([
      "2026-09-07T03:00:00.000Z",
      "2026-10-07T02:59:59.999Z",
    ]);
  });

  it("this_month começa no dia 1", () => {
    expect(iso(computePainelRange("this_month", null, null, now))).toEqual([
      "2026-10-01T03:00:00.000Z",
      "2026-10-07T02:59:59.999Z",
    ]);
  });

  it("yesterday e last_month cobrem o dia e o mês anteriores", () => {
    expect(iso(computePainelRange("yesterday", null, null, now))).toEqual([
      "2026-10-05T03:00:00.000Z",
      "2026-10-06T02:59:59.999Z",
    ]);
    expect(iso(computePainelRange("last_month", null, null, now))).toEqual([
      "2026-09-01T03:00:00.000Z",
      "2026-10-01T02:59:59.999Z",
    ]);
  });

  it("custom usa as datas em SP; inválido ou invertido cai em hoje", () => {
    expect(iso(computePainelRange("custom", "2026-09-01", "2026-09-30", now))).toEqual([
      "2026-09-01T03:00:00.000Z",
      "2026-10-01T02:59:59.999Z",
    ]);
    const today = ["2026-10-06T03:00:00.000Z", "2026-10-07T02:59:59.999Z"];
    expect(iso(computePainelRange("custom", "2026-09-30", "2026-09-01", now))).toEqual(today);
    expect(iso(computePainelRange("custom", "30/09/2026", "2026-09-30", now))).toEqual(today);
    expect(iso(computePainelRange("custom", null, null, now))).toEqual(today);
  });
});

describe("clampRangeFromEnd", () => {
  it("devolve o mesmo objeto quando já cabe", () => {
    const range = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") };
    expect(clampRangeFromEnd(range, PAINEL_MAX_RANGE_MS)).toBe(range);
  });

  it("mantém o fim e recua o início para o teto", () => {
    const to = new Date("2026-10-06T00:00:00Z");
    const out = clampRangeFromEnd({ from: new Date("2025-01-01T00:00:00Z"), to }, PAINEL_MAX_RANGE_MS);
    expect(out.to).toBe(to);
    expect(out.to.getTime() - out.from.getTime()).toBe(90 * 24 * HOUR);
  });
});
