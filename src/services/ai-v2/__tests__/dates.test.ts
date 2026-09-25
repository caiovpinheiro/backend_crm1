import { describe, expect, it } from "vitest";

import { markPastDates } from "../dates";

// 24/09/2026, 17h em São Paulo.
const NOW = new Date("2026-09-24T20:00:00Z");

describe("markPastDates", () => {
  it("marca intervalo que já acabou e deixa o futuro como está", () => {
    const t = "Evento A - Ref. Agosto: de 11 a 14 de setembro de 2026.\nEvento A - Ref. Setembro: de 02 a 05 de outubro de 2026.";
    expect(markPastDates(t, NOW)).toBe(
      "Evento A - Ref. Agosto: de 11 a 14 de setembro de 2026 (já passou).\nEvento A - Ref. Setembro: de 02 a 05 de outubro de 2026.",
    );
  });

  it("intervalo que termina hoje ou depois não é passado", () => {
    expect(markPastDates("de 20 a 24 de setembro", NOW)).toBe("de 20 a 24 de setembro");
    expect(markPastDates("de 20 a 26 de setembro", NOW)).toBe("de 20 a 26 de setembro");
  });

  it("datas numéricas e intervalo entre meses", () => {
    expect(markPastDates("Entrega até 15/09/2026; renovação 01/10/2026", NOW)).toBe(
      "Entrega até 15/09/2026 (já passou); renovação 01/10/2026",
    );
    expect(markPastDates("de 30 de agosto a 2 de setembro de 2026", NOW)).toBe("de 30 de agosto a 2 de setembro de 2026 (já passou)");
  });

  it("sem ano: usa o ano mais perto de hoje (janeiro é do ano que vem)", () => {
    expect(markPastDates("de 27 a 30 de janeiro", NOW)).toBe("de 27 a 30 de janeiro");
    expect(markPastDates("dia 10 de agosto", NOW)).toBe("dia 10 de agosto (já passou)");
  });

  it("não marca duas vezes nem mexe em texto sem data", () => {
    const once = markPastDates("10 de agosto de 2026", NOW);
    expect(markPastDates(once, NOW)).toBe(once);
    expect(markPastDates("Acesse a Área do Cliente.", NOW)).toBe("Acesse a Área do Cliente.");
    expect(markPastDates("Atendimento 24/7 pelo app", NOW)).toBe("Atendimento 24/7 pelo app");
  });
});
