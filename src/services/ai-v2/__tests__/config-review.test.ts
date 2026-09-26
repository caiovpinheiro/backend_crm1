import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { checkSuggestions, parseReview, suggestionFingerprint } from "../config-review";

const config = normalizeV2Config({
  name: "Agente",
  tone: "Cordial",
  autonomyMode: "auto",
  themes: [{ id: "t1", name: "Entrega", when: ["prazo"], examples: [], instructions: "Explique o prazo." }],
  handoff: { defaultDestination: { type: "department", id: "dep-1" }, message: "Vou transferir." },
} as never);

describe("revisão da configuração com IA", () => {
  it("lê o JSON do modelo, mesmo com cerca de código e campos faltando", () => {
    const text = "```json\n" + JSON.stringify({
      resumo: "Dois ajustes.",
      sugestoes: [
        { titulo: "Gatilho", gravidade: "alta", problema: "p", alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "entrega" }] },
        { titulo: "Sem alteração", gravidade: "urgentissima", correcao: "escrever material" },
      ],
    }) + "\n```";
    const r = parseReview(text);
    expect(r?.resumo).toBe("Dois ajustes.");
    expect(r?.sugestoes).toHaveLength(2);
    expect(r?.sugestoes[1].gravidade).toBe("media");
    expect(r?.sugestoes[1].alteracoes).toEqual([]);
    expect(parseReview("não consegui")).toBeNull();
  });

  it("marca o que dá para aplicar, guarda o valor anterior e explica o que não dá", () => {
    const out = checkSuggestions(config, [
      { titulo: "Gatilho", gravidade: "alta", area: "", problema: "", evidencia: "", correcao: "", atendimentos: [], pontos: [], alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "entrega" }] },
      { titulo: "Assunto inexistente", gravidade: "media", area: "", problema: "", evidencia: "", correcao: "", atendimentos: [], pontos: [], alteracoes: [{ path: "themes[id=zz].when", op: "add", value: "x" }] },
      { titulo: "Invalida", gravidade: "baixa", area: "", problema: "", evidencia: "", correcao: "", atendimentos: [], pontos: [], alteracoes: [{ path: "autonomyMode", op: "set", value: "qualquer" }] },
      { titulo: "Fora da config", gravidade: "baixa", area: "", problema: "", evidencia: "", correcao: "Escrever material.", atendimentos: [], pontos: [], alteracoes: [] },
    ]);
    expect(out.map((s) => s.id)).toEqual(["S01", "S02", "S03", "S04"]);
    expect(out[0].aplicavel).toBe(true);
    expect(out[0].alteracoes[0].before).toEqual(["prazo"]);
    expect(out[1].aplicavel).toBe(false);
    expect(out[1].erro).toMatch(/Item não encontrado/);
    expect(out[2].aplicavel).toBe(false);
    expect(out[2].erro).toMatch(/inválida/);
    expect(out[3].aplicavel).toBe(false);
    expect(out[3].erro).toBeUndefined();
  });
  it("converge: descarta o que já está assim e o recusado antes; alta só com prova", () => {
    const base = { area: "", problema: "", evidencia: "", correcao: "", pontos: [] as string[] };
    const add = { path: "themes[id=t1].when", op: "add" as const, value: "entrega" };
    const refused = suggestionFingerprint({ titulo: "x", alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "frete" }] });
    const out = checkSuggestions(config, [
      { ...base, titulo: "Já está assim", gravidade: "alta", atendimentos: ["T01"], alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "prazo" }] },
      { ...base, titulo: "Recusada antes, outro título", gravidade: "alta", atendimentos: ["T01"], alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "frete" }] },
      { ...base, titulo: "Alta sem prova", gravidade: "alta", atendimentos: ["T99"], alteracoes: [add] },
      { ...base, titulo: "Alta com prova", gravidade: "alta", atendimentos: ["T02"], alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "envio" }] },
      { ...base, titulo: "Repetida", gravidade: "media", atendimentos: [], alteracoes: [add] },
    ], { turnIds: new Set(["T01", "T02"]), gapIds: new Set(), highGapIds: new Set(), skipFingerprints: new Set([refused]) });
    expect(out.map((s) => [s.id, s.titulo, s.gravidade])).toEqual([
      ["S01", "Alta com prova", "alta"],
      ["S02", "Alta sem prova", "media"],
    ]);
    expect(out[1].rebaixada).toMatch(/Sem atendimento/);
    expect(out[1].atendimentos).toEqual([]);
  });
});
