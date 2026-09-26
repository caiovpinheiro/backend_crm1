import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

/**
 * Modelos do agente v2: cada fornecedor recebe só o que aceita — modelos que
 * raciocinam sem temperatura e com folga de tokens; Claude sem modo JSON.
 */

type Seen = { provider: string; model: string; temperature?: number; maxOutputTokens?: number; responseFormat?: unknown; providerOptions?: unknown };
const seen: Seen[] = [];
const mockFor = (provider: string, model: string) =>
  new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push({
        provider,
        model,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        responseFormat: options.responseFormat,
        providerOptions: options.providerOptions,
      });
      return {
        content: [{ type: "text", text: "{}" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      } as any;
    },
  });

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => (model: string) => mockFor("openai", model) }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => (model: string) => mockFor("anthropic", model) }));

import { generateWithTools } from "../provider";
import { v2AuxModel, v2ModelProvider } from "@/lib/ai-v2/models";
import { estimateCost } from "@/lib/ai-agents/pricing";

const call = (model: string, extra: Record<string, unknown> = {}) =>
  generateWithTools({ model, apiKey: "k", system: "s", messages: [{ role: "user", content: "oi" }], temperature: 0.4, maxOutputTokens: 500, jsonMode: true, ...extra });

describe("modelos do agente v2", () => {
  it("modelo sem raciocínio: temperatura e modo JSON como antes", async () => {
    seen.length = 0;
    await call("gpt-4o-mini");
    expect(seen[0]).toMatchObject({ provider: "openai", temperature: 0.4, maxOutputTokens: 500, responseFormat: { type: "json" } });
  });

  it("GPT-6: sem temperatura, raciocínio forçado e baixo, com folga de tokens", async () => {
    seen.length = 0;
    await call("gpt-6-luna");
    expect(seen[0].temperature).toBeUndefined();
    expect(seen[0].maxOutputTokens).toBe(4500);
    expect(seen[0].providerOptions).toMatchObject({ openai: { reasoningEffort: "low", forceReasoning: true } });
  });

  it("Claude vai para a Anthropic, sem modo JSON; Sonnet 5 sem temperatura e com esforço baixo", async () => {
    seen.length = 0;
    await call("claude-sonnet-5");
    await call("claude-haiku-4-5");
    expect(seen[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(seen[0].responseFormat).toBeUndefined();
    expect(seen[0].temperature).toBeUndefined();
    expect(seen[0].providerOptions).toMatchObject({ anthropic: { effort: "low" } });
    expect(seen[1]).toMatchObject({ provider: "anthropic", temperature: 0.4, maxOutputTokens: 500 });
  });

  it("tarefas auxiliares ficam na OpenAI e os preços vêm da tabela", () => {
    expect(v2ModelProvider("claude-opus-5")).toBe("anthropic");
    expect(v2AuxModel("claude-opus-5")).toBe("gpt-4.1-mini");
    expect(v2AuxModel("gpt-6-sol")).toBe("gpt-6-sol");
    expect(estimateCost("gpt-6-luna", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(estimateCost("claude-sonnet-5", 1_000_000, 0)).toBeCloseTo(2);
  });
});
