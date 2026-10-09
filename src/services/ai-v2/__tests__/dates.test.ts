import { describe, expect, it } from "vitest";

import { markPastDates, tenseMismatches } from "../dates";

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

describe("tenseMismatches — tempo verbal x data", () => {
  // 09/10/2026, 15h em São Paulo.
  const TODAY = new Date("2026-10-09T18:00:00Z");

  it("data que ainda vem dita no passado: troca o verbo", () => {
    const [t] = tenseMismatches("Vamos localizar a avaliação. As provas da primeira etapa foram realizadas de 06/11 a 09/11/2026. Qual é a disciplina?", TODAY);
    expect(t.sentence).toBe("As provas da primeira etapa foram realizadas de 06/11 a 09/11/2026.");
    expect(t.fixed).toBe("As provas da primeira etapa serão realizadas de 06/11 a 09/11/2026.");
    expect(t.why).toContain("06/11/2026 a 09/11/2026 ainda vem");
    expect(tenseMismatches("A entrega foi de 20/11 a 22/11.", TODAY)[0]?.fixed).toBe("A entrega será de 20/11 a 22/11.");
    expect(tenseMismatches("O encontro já aconteceu em 15 de novembro.", TODAY)[0]?.fixed).toBe("O encontro acontece em 15 de novembro.");
  });

  it("sem troca possível ('já passou'), devolve a frase para sair", () => {
    const [t] = tenseMismatches("O prazo de 30/11 já passou.", TODAY);
    expect(t.sentence).toBe("O prazo de 30/11 já passou.");
    expect(t.fixed).toBeNull();
  });

  it("data que já passou dita no futuro: troca o verbo", () => {
    expect(tenseMismatches("A prova será realizada em 06/09/2026.", TODAY)[0]?.fixed).toBe("A prova foi realizada em 06/09/2026.");
    expect(tenseMismatches("As notas vão sair dia 20/09.", TODAY)).toEqual([]);
  });

  it("não mexe: período em andamento, verbo de outra oração, remarcação para o futuro, valor sem data", () => {
    expect(tenseMismatches("As inscrições foram realizadas de 01/10 a 30/10.", TODAY)).toEqual([]);
    expect(tenseMismatches("A inscrição foi feita e a prova será 06/11.", TODAY)).toEqual([]);
    expect(tenseMismatches("O prazo foi prorrogado para 20/11.", TODAY)).toEqual([]);
    expect(tenseMismatches("O valor foi de 100 reais.", TODAY)).toEqual([]);
  });
});
