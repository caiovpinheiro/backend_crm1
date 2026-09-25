import { it, expect } from "vitest";
import { normalizeV2Config } from "@/lib/ai-v2/config";
it("calendário: linha incompleta sai, rascunho não falha", () => {
  const c = normalizeV2Config({ name: "A", tone: "t", calendar: { events: [
    { id: "a", start: "2026-10-19", title: "Resultados" },
    { id: "b", start: "2026-10-20", title: "" },
    { id: "c", start: "", title: "Sem data" },
    { id: "d", start: "2026-11-27", end: "2026-11-30", title: " Evento " },
    { id: "e", start: "2026-11-27", end: "2026-11-01", title: "Fim antes do início" },
  ] } } as never);
  expect(c.calendar?.events.map((e) => [e.id, e.end ?? null, e.title])).toEqual([["a", null, "Resultados"], ["d", "2026-11-30", "Evento"], ["e", null, "Fim antes do início"]]);
});
