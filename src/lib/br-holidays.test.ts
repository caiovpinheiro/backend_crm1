import { describe, expect, it } from "vitest";

import { brHolidayName, easterSunday, isBrazilTimezone, isBrBusinessDay, nextBrBusinessDay } from "./br-holidays";
import { businessDayNote, currentDateLine } from "@/services/ai-v2/llm";

describe("feriados nacionais e próximo dia útil", () => {
  it("Páscoa e feriados móveis", () => {
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe("2026-04-05");
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe("2027-03-28");
    expect(brHolidayName("2026-04-03")).toBe("Sexta-feira Santa");
    expect(brHolidayName("2026-02-16")).toBe("Carnaval");
    expect(brHolidayName("2026-02-17")).toBe("Carnaval");
    expect(brHolidayName("2026-06-04")).toBe("Corpus Christi");
    expect(brHolidayName("2026-10-12")).toBe("Nossa Senhora Aparecida");
    expect(brHolidayName("2026-10-13")).toBeNull();
  });

  it("próximo dia útil pula fim de semana e feriado", () => {
    // Domingo 11/10/2026 → segunda 12/10 é feriado → terça 13/10.
    expect(nextBrBusinessDay("2026-10-11")).toBe("2026-10-13");
    // Sexta → segunda.
    // Sexta 09/10 → segunda 12/10 é feriado → terça 13/10.
    expect(nextBrBusinessDay("2026-10-09")).toBe("2026-10-13");
    expect(nextBrBusinessDay("2026-10-16")).toBe("2026-10-19");
    // Carnaval: sábado 14/02 → quarta 18/02.
    expect(nextBrBusinessDay("2026-02-14")).toBe("2026-02-18");
    expect(isBrBusinessDay("2026-10-12")).toBe(false);
    expect(isBrBusinessDay("2026-10-13")).toBe(true);
  });

  it("linha de data do prompt traz o próximo dia útil e o feriado no meio; fora do Brasil, nada", () => {
    const sunday = new Date("2026-10-11T15:00:00Z");
    const note = businessDayNote("America/Sao_Paulo", sunday);
    expect(note).toContain("Próximo dia útil: terça-feira, 13/10");
    expect(note).toContain("segunda-feira, 12/10 é feriado (Nossa Senhora Aparecida)");
    expect(currentDateLine("America/Sao_Paulo", sunday)).toContain("Próximo dia útil: terça-feira, 13/10");
    expect(businessDayNote("America/Sao_Paulo", new Date("2026-10-12T15:00:00Z"))).toContain("Hoje é feriado (Nossa Senhora Aparecida)");
    expect(businessDayNote("Europe/Lisbon", sunday)).toBe("");
    expect(isBrazilTimezone("America/Manaus")).toBe(true);
    expect(isBrazilTimezone("America/New_York")).toBe(false);
  });
});
