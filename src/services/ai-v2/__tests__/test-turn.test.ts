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

function baseConfig(): V2AgentConfig {
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
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", baseConfig(), "oi");
    expect(result.reply).toBe("Olá!");
  });
});
