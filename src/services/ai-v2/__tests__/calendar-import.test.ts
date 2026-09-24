import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));

import { generateWithTools } from "@/services/ai/provider";
import { importCalendarText } from "../calendar-import";

const gen = generateWithTools as ReturnType<typeof vi.fn>;

describe("importCalendarText", () => {
  beforeEach(() => gen.mockReset());

  it("texto já em linhas: lê direto, sem chamar o modelo", async () => {
    const r = await importCalendarText({ text: "19/10/2026 – Liberação de notas\n02/10/2026 a 05/10/2026 – Prova", defaultYear: 2026, model: "m", apiKey: "k" });
    expect(r.method).toBe("lines");
    expect(r.events).toHaveLength(2);
    expect(gen).not.toHaveBeenCalled();
  });

  it("texto bagunçado (ou PDF): o modelo organiza, em modo JSON", async () => {
    gen.mockResolvedValue({ text: JSON.stringify({ events: [{ start: "2026-10-19", title: "Liberação de notas" }, { start: "2026-11-27", end: "2026-11-30", title: "Prova" }] }) });
    const r = await importCalendarText({ text: "OUTUBRO\n19 Liberação de notas\nNOVEMBRO\n27 a 30 Prova", defaultYear: 2026, model: "m", apiKey: "k" });
    expect(r.method).toBe("ai");
    expect(r.events.map((e) => [e.start, e.end ?? null])).toEqual([["2026-10-19", null], ["2026-11-27", "2026-11-30"]]);
    expect(gen.mock.calls[0][0].jsonMode).toBe(true);
  });

  it("resposta inválida do modelo vira erro claro", async () => {
    gen.mockResolvedValue({ text: "não sei" });
    await expect(importCalendarText({ text: "OUTUBRO\n19 notas", defaultYear: 2026, model: "m", apiKey: "k", forceAi: true })).rejects.toThrow(/dd\/mm\/aaaa/);
  });
});
