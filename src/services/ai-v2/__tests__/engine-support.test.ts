import { beforeEach, describe, expect, it, vi } from "vitest";

import type { V2AgentConfig } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  conversationUpdateMany: vi.fn(),
  conversationUpdate: vi.fn(),
  executeDistribution: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { updateMany: mocks.conversationUpdateMany, update: mocks.conversationUpdate },
  },
}));

vi.mock("@/services/distribution", () => ({
  executeDistribution: mocks.executeDistribution,
}));

vi.mock("@/services/lead-distribution", () => ({
  isAgentAvailable: vi.fn().mockResolvedValue(true),
}));

import { simpleHandoff } from "../handoff";
import { guardV2Output } from "../output-guard";
import { evaluateV2StopLimits, defaultV2Counters } from "../limits";
import { classifyPostCloseMessage } from "../closure";
import { knowledgeDocIdsFor, selectV2Theme } from "../themes";
import { answerFromKnowledge } from "../ground-reply";

describe("simpleHandoff — nunca deixa a conversa com a IA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
    // Distribuição desligada: não mexe no responsável.
    mocks.executeDistribution.mockResolvedValue({ success: false, reason: "DISTRIBUTION_DISABLED" });
  });

  it("handoff para departamento com distribuição desligada libera o responsável IA", async () => {
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "department", id: "dep-1" } });

    expect(mocks.executeDistribution).toHaveBeenCalled();
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith({
      where: { id: "conv-1", assignedTo: { type: "AI" } },
      data: { assignedToId: null },
    });
  });

  it("handoff para outro agente de IA não libera (a conversa é dele)", async () => {
    const prismaMod = await import("@/lib/prisma");
    (prismaMod.prisma as any).aIAgentConfig = { findUnique: vi.fn().mockResolvedValue({ userId: "ai-2" }) };

    await simpleHandoff({ conversationId: "conv-1", destination: { type: "ai_agent", id: "agent-2" } });

    expect(mocks.conversationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "ai-2" } });
  });
});

describe("guardV2Output", () => {
  it("promessa de retorno sinaliza handoff", () => {
    const r = guardV2Output("Vou verificar e te retorno logo.", []);
    expect(r.forceHandoff).toBe(true);
  });

  it("resposta normal não sinaliza handoff", () => {
    expect(guardV2Output("Sua assinatura está ativa.", []).forceHandoff).toBe(false);
  });

  it("remoção de campo interno só casa a palavra inteira", () => {
    const r = guardV2Output("A unidade de Anápolis atende você, Ana.", [], {
      contact: { name: "Ana" },
      citableContact: {},
      selectedDeal: null,
      citableDeal: null,
    });
    expect(r.text).toContain("Anápolis");
    expect(r.text).not.toContain(", Ana.");
  });
});

describe("limites de parada", () => {
  function config(limits: Record<string, number>): V2AgentConfig {
    return {
      limits: {
        maxCourtesyReplies: 1,
        maxHelpOffers: 1,
        maxStalledExchanges: 2,
        stalledExchangesAction: "handoff",
        nonsenseLimit: 3,
        nonsenseAction: "warn_and_silence",
        maxLoopCount: 3,
        maxAiTransfers: 3,
        ...limits,
      },
    } as unknown as V2AgentConfig;
  }

  it("limite 0 não bloqueia antes de o contador andar", () => {
    const r = evaluateV2StopLimits(
      config({ maxCourtesyReplies: 0, maxHelpOffers: 0, maxStalledExchanges: 0, nonsenseLimit: 0 }),
      defaultV2Counters(),
      "Oi",
    );
    expect(r.blocksReply).toBe(false);
  });

  it("countLoop=false não conta a mesma mensagem duas vezes no turno", () => {
    const cfg = config({ maxLoopCount: 2 });
    const counters = defaultV2Counters();
    evaluateV2StopLimits(cfg, counters, "oi");
    const again = evaluateV2StopLimits(cfg, counters, "oi", { countLoop: false });
    expect(counters.loopCount).toBe(1);
    expect(again.blocksReply).toBe(false);
  });

  it("mensagens sem sentido seguidas atingem o limite", () => {
    const counters = { ...defaultV2Counters(), nonsenseMessages: 3 };
    const r = evaluateV2StopLimits(config({ nonsenseLimit: 3 }), counters, "asdf", { countLoop: false });
    expect(r.blocksReply).toBe(true);
  });
});

describe("classifyPostCloseMessage — resposta à pergunta de opções", () => {
  const cfg = {} as V2AgentConfig;

  it("'1' e 'sim' são nova demanda; '2' é cortesia", () => {
    expect(classifyPostCloseMessage(cfg, "1")).toBe("new_demand");
    expect(classifyPostCloseMessage(cfg, "Sim")).toBe("new_demand");
    expect(classifyPostCloseMessage(cfg, "2")).toBe("courtesy");
  });
});

describe("selectV2Theme — flexões da mesma palavra", () => {
  const cfg = {
    themes: [{ id: "comp", name: "Comprovantes", when: ["comprovante de cadastro"], examples: [] }],
  } as unknown as V2AgentConfig;

  it("'comprovante de que me cadastrei' casa o assunto 'comprovante de cadastro'", () => {
    expect(selectV2Theme(cfg, "estão pedindo um comprovante de que me cadastrei")?.id).toBe("comp");
  });

  it("palavra curta dentro do gatilho não casa ('um' em 'documento')", () => {
    const docs = { themes: [{ id: "d", name: "Docs", when: ["documento"], examples: [] }] } as unknown as V2AgentConfig;
    expect(selectV2Theme(docs, "estão pedindo um comprovante")).toBeNull();
    expect(selectV2Theme(docs, "preciso de um documento")?.id).toBe("d");
    expect(selectV2Theme(docs, "preciso dos documentos")?.id).toBe("d");
  });

  it("mensagem sem relação não casa", () => {
    expect(selectV2Theme(cfg, "quero saber o preço do serviço")).toBeNull();
  });
});

describe("knowledgeDocIdsFor — materiais do assunto somam aos globais", () => {
  it("assunto com lista própria não esconde os materiais globais", () => {
    const cfg = { allowedKnowledgeDocIds: ["know_doc_001", "know_doc_002"] } as unknown as V2AgentConfig;
    const theme = { allowedKnowledgeDocIds: ["cmud56v66"], knowledgeDocIds: [] } as any;
    expect(knowledgeDocIdsFor(cfg, theme)).toEqual(["cmud56v66", "know_doc_001", "know_doc_002"]);
  });

  it("sem assunto vale a lista global; sem duplicatas", () => {
    const cfg = { allowedKnowledgeDocIds: ["a", "b"] } as unknown as V2AgentConfig;
    expect(knowledgeDocIdsFor(cfg, null)).toEqual(["a", "b"]);
    expect(knowledgeDocIdsFor(cfg, { allowedKnowledgeDocIds: ["b"], knowledgeDocIds: ["a"] } as any)).toEqual(["b", "a"]);
  });
});

describe("answerFromKnowledge — modelo que já recebeu os trechos", () => {
  it("mantém a resposta do modelo (não troca por trecho cru)", async () => {
    const reply = "Você pode emitir pela área do cliente. Precisa de ajuda em algum passo?";
    const out = await answerFromKnowledge({
      reply,
      toolCalls: [{ toolName: "knowledge_search", args: { query: "q", prefetch: true }, result: { chunks: [{ content: "Trecho totalmente diferente sobre outra coisa" }] } }],
      config: { allowedKnowledgeDocIds: ["d1"], themes: [] } as unknown as V2AgentConfig,
      userMessage: "como emito o comprovante",
      agentId: "agent-1",
    });
    expect(out).toBe(reply);
  });
});

