import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { checkSuggestions, parseReview } from "../config-review";

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
      { titulo: "Gatilho", gravidade: "alta", area: "", problema: "", evidencia: "", correcao: "", alteracoes: [{ path: "themes[id=t1].when", op: "add", value: "entrega" }] },
      { titulo: "Assunto inexistente", gravidade: "media", area: "", problema: "", evidencia: "", correcao: "", alteracoes: [{ path: "themes[id=zz].when", op: "add", value: "x" }] },
      { titulo: "Invalida", gravidade: "baixa", area: "", problema: "", evidencia: "", correcao: "", alteracoes: [{ path: "autonomyMode", op: "set", value: "qualquer" }] },
      { titulo: "Fora da config", gravidade: "baixa", area: "", problema: "", evidencia: "", correcao: "Escrever material.", alteracoes: [] },
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
});
