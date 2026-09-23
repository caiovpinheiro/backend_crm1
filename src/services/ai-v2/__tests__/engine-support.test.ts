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
import { selectV2Theme } from "../themes";

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
    expect(guardV2Output("Sua matrícula está ativa.", []).forceHandoff).toBe(false);
  });

  it("remoção de campo interno só casa a palavra inteira", () => {
    const r = guardV2Output("O polo de Anápolis atende você, Ana.", [], {
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
    themes: [{ id: "decl", name: "Declaração", when: ["declaração de matrícula"], examples: [] }],
  } as unknown as V2AgentConfig;

  it("'declaração que me matriculei' casa o assunto 'declaração de matrícula'", () => {
    expect(selectV2Theme(cfg, "minha empresa está pedindo uma declaração que me matriculei")?.id).toBe("decl");
  });

  it("mensagem sem relação não casa", () => {
    expect(selectV2Theme(cfg, "quero saber o valor da mensalidade")).toBeNull();
  });
});
