import { describe, it, expect, vi } from "vitest";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  tryGetAgentApiKey: vi.fn(),
  callV2LLMTest: vi.fn(),
}));

vi.mock("@/services/ai/agent-key", () => ({
  tryGetAgentApiKey: mocks.tryGetAgentApiKey,
}));

vi.mock("../llm", () => ({
  callV2LLMTest: mocks.callV2LLMTest,
}));

function baseConfig(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
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
    ...overrides,
  } as unknown as V2AgentConfig;
}

describe("simulateV2Turn", () => {
  it("lança NO_OPENAI_KEY quando não há chave configurada (parte B, item 2)", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue(null);
    const { simulateV2Turn } = await import("../test-turn");
    await expect(simulateV2Turn("agent-1", baseConfig(), "oi")).rejects.toThrow("NO_OPENAI_KEY");
  });

  it("retorna resultado quando há chave configurada", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.callV2LLMTest.mockResolvedValue({
      output: {
        reply: "Olá!",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Saudação",
        actions: [],
      },
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [],
      systemPrompt: "# Tom de voz\nObjetivo",
    });
    const cfg = baseConfig();
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "oi");
    expect(result.reply).toBe("Olá!");
    expect(result.crmContext.contact).toBeNull();
  });

  it("aplica mensagem de 'sem material' quando busca volta vazia e não há dados do cliente", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.callV2LLMTest.mockResolvedValue({
      output: {
        reply: "Acho que é isso.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Tentativa",
        actions: [],
      },
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [{ toolName: "knowledge_search", args: { query: "x" }, result: { chunks: [] } }],
      systemPrompt: "# Tom de voz\nObjetivo",
    });
    const cfg = baseConfig({
      fallback: { noSource: { message: "Não encontrei isso nos materiais; um consultor vai te ajudar." } } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "Como funciona x?");
    expect(result.handoff).toBe(false);
    expect(result.reply).toBe("Não encontrei isso nos materiais; um consultor vai te ajudar.");
    expect(result.reason).toContain("sem resultados");
  });
});
