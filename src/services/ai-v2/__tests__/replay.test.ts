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
  it("ponto não comparável com campos nulos não vira falha técnica", () => {
    const r = parseVerdict('{"comparavel":false,"motivoNaoComparavel":"sem_conteudo","desfecho":null,"correto":null,"inventou":null,"invencao":null,"humanoConsultouSistema":null,"causa":null,"tom":null,"assunto":"Saudação","explicacao":null}');
    expect(r).not.toBeNull();
    expect(r?.comparavel).toBe(false);
    expect(r?.invencao).toBe("");
    expect(r?.explicacao).toBe("");
  });
  it("ponto é comparável por padrão e lê o motivo quando não é", () => {
    expect(parseVerdict('{"desfecho":"igual"}')?.comparavel).toBe(true);
    const r = parseVerdict('{"comparavel":false,"motivoNaoComparavel":"teste"}');
    expect(r?.comparavel).toBe(false);
    expect(r?.motivoNaoComparavel).toBe("teste");
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

describe("notas 0–100", () => {
  it("atendimento pondera os resultados; só materiais conta invenção; tempo p90", async () => {
    const { replayScores } = await import("../replay");
    const s = summarizeReplay([
      item({ verdict: v({ desfecho: "igual" }), latencyMs: 4000 }),
      item({ verdict: v({ desfecho: "parcial" }), latencyMs: 6000 }),
      item({ verdict: v({ desfecho: "igual", inventou: true }), latencyMs: 9000 }),
      item({ verdict: v({ desfecho: "igual", tom: "inadequado" }), latencyMs: 20000 }),
    ]);
    // (1 + 0,5 + 0 + 1 − 0,2) / 4
    expect(s.notas).toEqual({ atendimento: 58, soMateriais: 75, tempoP90s: 20, avaliados: 4 });
    expect(replayScores({ avaliados: 0, inventou: 0, resultados: {} })).toEqual({ atendimento: null, soMateriais: null, tempoP90s: null, avaliados: 0 });
    // Placar antigo, sem tom nem tempo.
    expect(replayScores({ avaliados: 2, inventou: 0, resultados: { igual: 1, transferiu_sem_precisar: 1 } }).atendimento).toBe(63);
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

describe("parseConversationRefs", () => {
  it("aceita link da caixa de entrada, caminho e id solto, sem repetir", async () => {
    const { parseConversationRefs } = await import("../replay");
    const ids = parseConversationRefs(
      "https://crm.exemplo.com/inbox?c=cmabc12345xyz\nhttps://crm.exemplo.com/conversations/cmdef67890uvw, cmabc12345xyz  curto",
    );
    expect(ids).toEqual(["cmabc12345xyz", "cmdef67890uvw"]);
  });
  it("aceita o número do atendimento (link ?c=1234 e #1234)", async () => {
    const { parseConversationRefs } = await import("../replay");
    expect(parseConversationRefs("https://crm.exemplo.com/inbox?c=1234 #987 55")).toEqual(["1234", "987", "55"]);
  });
});
