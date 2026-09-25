import { describe, expect, it } from "vitest";

import { calendarPromptSection, eventStatus, parseCalendarText } from "../calendar";

// 24/09/2026, 17h em São Paulo.
const NOW = new Date("2026-09-24T20:00:00Z");

describe("parseCalendarText", () => {
  it("lê os formatos de data comuns e junta a continuação da linha", () => {
    const { events, unparsed } = parseCalendarText(
      [
        "Linha de abertura sem data",
        "== OUTUBRO de 2026 ==",
        "02/10/2026 a 05/10/2026 – Realização da Prova A1",
        "19/10/2026 – Liberação de Notas",
        "planilhas e relatórios via ambiente virtual",
        "11 e 12/12 – Prova final",
        "27 a 30 de novembro de 2026: Prova de novembro e dezembro",
        "5 de janeiro de 2027 - Início das aulas",
        "18/11/26 a 14/02/27 – Período de rematrícula",
      ].join("\n"),
      2026,
    );
    expect(events.map((e) => [e.start, e.end ?? null, e.title])).toEqual([
      ["2026-10-02", "2026-10-05", "Realização da Prova A1"],
      ["2026-10-19", null, "Liberação de Notas planilhas e relatórios via ambiente virtual"],
      ["2026-12-11", "2026-12-12", "Prova final"],
      ["2026-11-27", "2026-11-30", "Prova de novembro e dezembro"],
      ["2027-01-05", null, "Início das aulas"],
      ["2026-11-18", "2027-02-14", "Período de rematrícula"],
    ]);
    expect(unparsed).toEqual(["Linha de abertura sem data"]);
  });

  it("período com \"e\" entre datas completas", () => {
    const { events } = parseCalendarText("11/12/2026 e 12/12/2026 – Realização da Prova AF", 2026);
    expect(events).toEqual([{ id: expect.any(String), start: "2026-12-11", end: "2026-12-12", title: "Realização da Prova AF" }]);
  });

  it("recusa data que não existe", () => {
    expect(parseCalendarText("31/02/2026 – Evento", 2026).events).toHaveLength(0);
  });
});

describe("situação e seção do prompt", () => {
  const events = [
    { id: "1", start: "2026-09-11", end: "2026-09-14", title: "Prova de agosto" },
    { id: "2", start: "2026-09-24", title: "Evento de hoje" },
    { id: "3", start: "2026-09-20", end: "2026-09-30", title: "Período de inscrição" },
    { id: "4", start: "2026-10-19", title: "Liberação de notas" },
    { id: "5", start: "2025-01-10", title: "Muito antigo" },
  ];

  it("calcula já passou / hoje / em andamento / próximo", () => {
    expect(events.slice(0, 4).map((e) => eventStatus(e, "2026-09-24"))).toEqual(["past", "today", "ongoing", "upcoming"]);
  });

  it("monta a seção em ordem, com a situação, sem o que é muito antigo", () => {
    const s = calendarPromptSection(events, NOW);
    expect(s).toContain("# Calendário (datas e prazos)");
    expect(s).toContain("- 11/09/2026 a 14/09/2026 — Prova de agosto [já passou]");
    expect(s).toContain("- 24/09/2026 — Evento de hoje [hoje]");
    expect(s).toContain("- 20/09/2026 a 30/09/2026 — Período de inscrição [em andamento]");
    expect(s).toContain("- 19/10/2026 — Liberação de notas [próximo]");
    expect(s).not.toContain("Muito antigo");
    expect(s.indexOf("Prova de agosto")).toBeLessThan(s.indexOf("Liberação de notas"));
  });

  it("sem eventos, sem seção", () => {
    expect(calendarPromptSection([], NOW)).toBe("");
    expect(calendarPromptSection(undefined, NOW)).toBe("");
  });
});
