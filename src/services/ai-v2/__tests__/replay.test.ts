import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("../test-turn", () => ({ simulateV2Turn: vi.fn() }));
vi.mock("../agents", () => ({ getV2Agent: vi.fn() }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));
vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn() }));

import { buildEvaluatorInput, parseVerdict, pointOutcome, resolvedLikeHuman, summarizeReplay, type ReplayItemRow } from "../replay";

function item(over: Partial<ReplayItemRow>): ReplayItemRow {
  return {
    id: "i", conversationId: "c", pointIndex: 0, at: null, clientText: "x", humanText: "y",
    agentText: "z", agentHandoff: false, themeName: "Cancelamento", sources: [], verdict: null,
    skipReason: null, error: null, ...over,
  };
}
const v = (o: Record<string, unknown>) => parseVerdict(JSON.stringify(o))!;

describe("parseVerdict", () => {
  it("lê JSON cercado de texto e aplica padrão em campo inválido", () => {
    const r = parseVerdict('```json\n{"desfecho":"igual","causa":"xpto","inventou":false}\n```');
    expect(r?.desfecho).toBe("igual");
    expect(r?.causa).toBe("comportamento");
  });
  it("devolve null sem JSON", () => {
    expect(parseVerdict("não sei")).toBeNull();
  });
});

describe("resolvedLikeHuman", () => {
  it("pessoa consultou o sistema: acerto só se o agente transferiu", () => {
    const verdict = v({ desfecho: "diferente", humanoConsultouSistema: true });
    expect(resolvedLikeHuman({ agentHandoff: true, verdict })).toBe(true);
    expect(resolvedLikeHuman({ agentHandoff: false, verdict })).toBe(false);
  });
  it("invenção nunca conta como acerto", () => {
    expect(resolvedLikeHuman({ agentHandoff: false, verdict: v({ desfecho: "igual", inventou: true }) })).toBe(false);
  });
  it("transferir sem necessidade não conta como acerto", () => {
    expect(resolvedLikeHuman({ agentHandoff: true, verdict: v({ desfecho: "igual" }) })).toBe(false);
  });
});

describe("pointOutcome", () => {
  it("dá um único resultado por ponto, com prioridade para invenção e erro", () => {
    expect(pointOutcome({ agentHandoff: false, verdict: v({ desfecho: "igual" }) })).toBe("igual");
    expect(pointOutcome({ agentHandoff: false, verdict: v({ desfecho: "igual", inventou: true }) })).toBe("inventou");
    expect(pointOutcome({ agentHandoff: false, verdict: v({ desfecho: "igual", correto: "nao" }) })).toBe("incorreto");
    expect(pointOutcome({ agentHandoff: true, verdict: v({ desfecho: "igual" }) })).toBe("transferiu_sem_precisar");
    expect(pointOutcome({ agentHandoff: true, verdict: v({ desfecho: "diferente", humanoConsultouSistema: true }) })).toBe("transferiu_certo");
    expect(pointOutcome({ agentHandoff: false, verdict: v({ desfecho: "parcial", humanoConsultouSistema: true }) })).toBe("deveria_transferir");
    expect(pointOutcome({ agentHandoff: false, verdict: null })).toBeNull();
  });
});

describe("summarizeReplay", () => {
  it("separa não avaliáveis, erros e agrupa por assunto", () => {
    const s = summarizeReplay([
      item({ verdict: v({ desfecho: "igual", causa: "ok" }) }),
      item({ verdict: v({ desfecho: "diferente", causa: "material" }) }),
      item({ themeName: null, verdict: v({ desfecho: "parcial", causa: "integracao", assunto: "Boleto", humanoConsultouSistema: true }), agentHandoff: true }),
      item({ skipReason: "Resposta da pessoa só em mídia (áudio/arquivo)" }),
      item({ error: "falhou" }),
    ]);
    expect(s.pontos).toBe(5);
    expect(s.naoAvaliaveis).toBe(1);
    expect(s.erros).toBe(1);
    expect(s.geral.avaliados).toBe(3);
    expect(s.geral.resolveuComoHumano).toBe(2);
    expect(s.porAssunto.map((a) => a.assunto)).toEqual(["Cancelamento", "Boleto"]);
    expect(s.causas).toEqual({ ok: 1, material: 1, integracao: 1 });
    expect(s.geral.resultados).toEqual({ igual: 1, diferente: 1, transferiu_certo: 1 });
    const soma = Object.values(s.geral.resultados).reduce((a, b) => a + (b ?? 0), 0);
    expect(soma).toBe(s.geral.avaliados);
  });
});

describe("buildEvaluatorInput", () => {
  it("inclui cliente, pessoa, agente, transferência e trechos", () => {
    const t = buildEvaluatorInput({
      point: { index: 0, clientText: "quero cancelar", humanText: "qual o motivo?", history: [], skipReason: null, at: "" },
      agentReply: "Posso ajudar",
      agentHandoff: true,
      sources: [{ title: "Cancelamento", content: "Passo a passo", similarity: 0.8 }],
    });
    expect(t).toContain("quero cancelar");
    expect(t).toContain("qual o motivo?");
    expect(t).toContain("[o agente transferiu para uma pessoa]");
    expect(t).toContain("[1] Cancelamento: Passo a passo");
  });
});
