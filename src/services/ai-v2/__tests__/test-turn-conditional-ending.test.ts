import { describe, expect, it, vi } from "vitest";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  tryGetAgentApiKey: vi.fn(async () => "sk-test"),
  callV2LLMTest: vi.fn(),
}));

vi.mock("@/services/ai/agent-key", () => ({
  tryGetAgentApiKey: mocks.tryGetAgentApiKey,
  getAgentChatKey: vi.fn(async () => "api-key"),
  tryGetAgentAnthropicKey: vi.fn(async () => null),
}));
vi.mock("../llm", () => ({ callV2LLMTest: mocks.callV2LLMTest }));
vi.mock("@/services/ai/provider", () => ({ embedTexts: vi.fn().mockRejectedValue(new Error("sem rede no teste")) }));
vi.mock("../context", () => ({ loadV2Context: vi.fn(), buildAskDealMessage: vi.fn(), describeV2ContextForTrace: () => "" }));

const ENDING = {
  procedure: { enabled: true, phrases: ["Quando terminar, me avise se deu certo."], buttons: ["Deu certo", "Preciso de ajuda"] },
  info: { enabled: true, phrases: ["Posso ajudar em algo mais?"], buttons: [] },
};

function config(): V2AgentConfig {
  return {
    name: "Agente de teste",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: [],
    allowedDomains: [],
    contextFields: { contact: [], deal: [] },
    variables: [],
    entry: { confirmContact: false, onDealNotFound: "handoff" },
    handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["humano"] },
    closure: {},
    limits: {},
    media: {},
    sentiment: {},
    survey: {},
    themes: [],
    rules: [],
    autonomyMode: "auto",
    replyEnding: ENDING,
  } as unknown as V2AgentConfig;
}

function llm(reply: string, handoff: boolean) {
  return {
    output: { reply, confirmed: null, handoff, concluded: false, outOfScope: false, sentiment: "neutral", collected: {}, reason: "r", actions: [] },
    inputTokens: 10, outputTokens: 5, latencyMs: 100,
    toolCalls: [{ toolName: "knowledge_search", args: { query: "x" }, result: { chunks: [{ docId: "d", docTitle: "T", content: "conteúdo", distance: 0.2 }] } }],
    systemPrompt: "",
  };
}

const STEPS = "Confira o desconto na fatura:\n1. Abra o aplicativo.\n2. Veja o valor com desconto.";

describe("fecho e transferência condicional (paridade produção × teste)", () => {
  it("resposta que condiciona a transferência espera o cliente e não ganha o fecho de passo a passo", async () => {
    const { simulateV2Turn } = await import("../test-turn");
    mocks.callV2LLMTest.mockResolvedValueOnce(llm(`${STEPS}\nSe o valor continuar diferente do contratado, encaminho o caso à equipe.`, true));
    const r = await simulateV2Turn("agent-1", config(), "minha fatura veio mais alta", [], undefined, undefined, undefined, "active", null, { skipEntry: true });
    expect(r.handoff).toBe(false);
    expect(r.reply).not.toContain("Quando terminar, me avise se deu certo.");
    expect(r.interactive).toBeNull();
  });

  it("passo a passo sem transferência continua com o fecho e os botões", async () => {
    const { simulateV2Turn } = await import("../test-turn");
    mocks.callV2LLMTest.mockResolvedValueOnce(llm(STEPS, false));
    const r = await simulateV2Turn("agent-1", config(), "como vejo o desconto?", [], undefined, undefined, undefined, "active", null, { skipEntry: true });
    expect(r.reply).toContain("Quando terminar, me avise se deu certo.");
    expect(r.interactive?.labels).toEqual(["Deu certo", "Preciso de ajuda"]);
  });
});
