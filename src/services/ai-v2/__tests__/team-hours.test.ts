import { describe, expect, it } from "vitest";

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { activeTeamClosure, businessHoursText, isWithinV2BusinessHours, nextTeamOpening, outsideHoursNote } from "../rules";

/**
 * Horário da equipe com feriados nacionais (opção) e pausas da equipe
 * (treinamento, convenção): fora do horário, o aviso diz quando a equipe
 * volta de verdade.
 */

const week = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "22:00" })).concat([{ day: 6, start: "09:00", end: "17:00" }]);
const config = (bh: Record<string, unknown> = {}) =>
  normalizeV2Config({ name: "A", tone: "t", businessHours: { enabled: true, timezone: "America/Sao_Paulo", weekdays: week, ...bh } });

// Domingo 11/10/2026 20:00 em Brasília = 23:00 UTC; segunda 12/10 é feriado nacional.
const SUNDAY_NIGHT = new Date("2026-10-11T23:00:00Z");

describe("horário da equipe: feriados e pausas", () => {
  it("sem a opção de feriado: volta segunda às 08:00 (comportamento anterior)", () => {
    const next = nextTeamOpening(config(), SUNDAY_NIGHT);
    expect(next?.at.toISOString()).toBe("2026-10-12T11:00:00.000Z");
    expect(outsideHoursNote(config(), SUNDAY_NIGHT)).toContain("seguimos com você na segunda-feira, 12/10, às 08:00");
  });

  it("feriados sem expediente: pula a segunda feriado e diz o porquê", () => {
    const c = config({ holidaysClosed: true });
    const next = nextTeamOpening(c, SUNDAY_NIGHT);
    expect(next?.at.toISOString()).toBe("2026-10-13T11:00:00.000Z");
    expect(next?.unusual).toBe(true);
    const note = outsideHoursNote(c, SUNDAY_NIGHT);
    expect(note).toContain("Segunda-feira, 12/10 é feriado (Nossa Senhora Aparecida).");
    expect(note).toContain("seguimos com você na terça-feira, 13/10, às 08:00");
    // No próprio feriado, dentro da faixa da semana, a equipe está fora.
    expect(isWithinV2BusinessHours(c, new Date("2026-10-12T15:00:00Z"))).toBe(false);
    expect(isWithinV2BusinessHours(config(), new Date("2026-10-12T15:00:00Z"))).toBe(true);
  });

  it("pausa da equipe: fora do horário durante a pausa e volta no fim dela (dentro da faixa)", () => {
    const c = config({ closures: [{ id: "p1", label: "treinamento da equipe", startsAt: "2026-10-14T08:00", endsAt: "2026-10-14T13:00" }] });
    const during = new Date("2026-10-14T13:00:00Z"); // 10:00 em Brasília
    expect(isWithinV2BusinessHours(c, during)).toBe(false);
    expect(activeTeamClosure(c, during)?.closure.label).toBe("treinamento da equipe");
    const next = nextTeamOpening(c, during);
    expect(next?.at.toISOString()).toBe("2026-10-14T16:00:00.000Z"); // 13:00 em Brasília
    const note = outsideHoursNote(c, during);
    expect(note).toContain("A equipe está em treinamento da equipe.");
    expect(note).toContain("quarta-feira, 14/10, às 13:00");
    // Depois da pausa, volta ao normal.
    expect(isWithinV2BusinessHours(c, new Date("2026-10-14T17:00:00Z"))).toBe(true);
  });

  it("pausa de dias inteiros (convenção): volta no primeiro horário depois dela", () => {
    const c = config({ closures: [{ id: "p2", label: "convenção anual", startsAt: "2026-10-15T00:00", endsAt: "2026-10-17T00:00" }] });
    const next = nextTeamOpening(c, new Date("2026-10-15T15:00:00Z"));
    // Quinta e sexta em convenção → sábado 17/10 às 09:00.
    expect(next?.at.toISOString()).toBe("2026-10-17T12:00:00.000Z");
    expect(outsideHoursNote(c, new Date("2026-10-15T15:00:00Z"))).toContain("no sábado, 17/10, às 09:00");
  });

  it("dia com duas faixas: o intervalo entre elas é fora; a segunda faixa conta (antes só a primeira valia)", () => {
    const c = normalizeV2Config({ name: "A", tone: "t", businessHours: { enabled: true, timezone: "America/Sao_Paulo", weekdays: [{ day: 3, start: "08:00", end: "12:00" }, { day: 3, start: "13:00", end: "18:00" }] } });
    expect(isWithinV2BusinessHours(c, new Date("2026-10-14T13:00:00Z"))).toBe(true); // 10:00
    expect(isWithinV2BusinessHours(c, new Date("2026-10-14T15:30:00Z"))).toBe(false); // 12:30
    expect(isWithinV2BusinessHours(c, new Date("2026-10-14T18:00:00Z"))).toBe(true); // 15:00
    expect(nextTeamOpening(c, new Date("2026-10-14T15:30:00Z"))?.at.toISOString()).toBe("2026-10-14T16:00:00.000Z");
  });

  it("texto da empresa: {{retorno}} vira a data; sem ele, feriado/pausa acrescenta a data no fim", () => {
    const withTag = config({ holidaysClosed: true, offHoursMessage: "Atendemos {{horario}}. Voltamos {{retorno}}." });
    expect(outsideHoursNote(withTag, SUNDAY_NIGHT)).toBe("Atendemos seg a sex, 08:00 às 22:00; sáb, 09:00 às 17:00. Voltamos na terça-feira, 13/10, às 08:00.".replace("seg a sex", "segunda a sexta").replace("sáb,", "sábado,"));
    const noTag = config({ holidaysClosed: true, offHoursMessage: "Fora do horário. Sua mensagem fica registrada." });
    expect(outsideHoursNote(noTag, SUNDAY_NIGHT)).toBe("Fora do horário. Sua mensagem fica registrada. Segunda-feira, 12/10 é feriado (Nossa Senhora Aparecida). A equipe volta na terça-feira, 13/10, às 08:00.");
  });

  it("prompt: o horário diz feriado sem expediente, a pausa em andamento e quando a equipe volta", () => {
    const text = businessHoursText(config({ holidaysClosed: true }), SUNDAY_NIGHT);
    expect(text).toContain("- feriados nacionais: sem atendimento da equipe");
    expect(text).toContain("- a equipe volta terça-feira, 13/10, às 08:00 (Segunda-feira, 12/10 é feriado (Nossa Senhora Aparecida))");
    const plain = businessHoursText(config(), SUNDAY_NIGHT);
    expect(plain).not.toContain("a equipe volta");
  });

  it("pausa sem início ou fim (linha incompleta da tela) é descartada", () => {
    const c = config({ closures: [{ id: "x", label: "y", startsAt: "", endsAt: "2026-10-14T13:00" }, { label: "ok", startsAt: "2026-10-14T08:00", endsAt: "2026-10-14T13:00" }] });
    expect(c.businessHours?.closures).toHaveLength(1);
    expect(c.businessHours?.closures?.[0].id).toBeTruthy();
  });
});
