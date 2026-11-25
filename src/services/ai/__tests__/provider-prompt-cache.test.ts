import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

/**
 * Cache de prompt da Anthropic: a parte estável do prompt de sistema (antes
 * do marcador) vai num bloco com cache_control; outros modelos recebem o
 * prompt inteiro, sem o marcador.
 */

type Seen = { provider: string; prompt: Array<{ role: string; content: unknown; providerOptions?: unknown }> };
const seen: Seen[] = [];
const mockFor = (provider: string) =>
  new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push({ provider, prompt: options.prompt as Seen["prompt"] });
      return {
        content: [{ type: "text", text: "{}" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1000, noCache: 100, cacheRead: 900, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      } as any;
    },
  });

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => mockFor("openai") }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => mockFor("anthropic") }));

import { generateWithTools } from "../provider";
import { SYSTEM_CACHE_BREAK, stripSystemCacheBreak } from "../prompt-cache";

const system = `# Tom de voz\nAmigável\n\n# Regras globais\nRegra longa${SYSTEM_CACHE_BREAK}# Data de hoje\n25/11/2026`;
const call = (model: string) => generateWithTools({ model, apiKey: "k", system, messages: [{ role: "user", content: "oi" }] });

afterEach(() => {
  seen.length = 0;
  delete process.env.AI_ANTHROPIC_PROMPT_CACHE;
});

describe("cache de prompt", () => {
  it("Claude: parte estável num bloco com cache_control, o resto do turno em outro; tokens lidos do cache voltam no resultado", async () => {
    const r = await call("claude-sonnet-5");
    const systems = seen[0].prompt.filter((m) => m.role === "system");
    expect(systems).toHaveLength(2);
    expect(systems[0].content).toBe("# Tom de voz\nAmigável\n\n# Regras globais\nRegra longa");
    expect(systems[0].providerOptions).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(systems[1].content).toBe("# Data de hoje\n25/11/2026");
    expect(systems[1].providerOptions).toBeUndefined();
    expect(r.cacheReadTokens).toBe(900);
  });

  it("OpenAI, ou cache desligado: um prompt só, sem o marcador", async () => {
    await call("gpt-4.1-mini");
    process.env.AI_ANTHROPIC_PROMPT_CACHE = "0";
    await call("claude-sonnet-5");
    for (const s of seen) {
      const systems = s.prompt.filter((m) => m.role === "system");
      expect(systems).toHaveLength(1);
      expect(systems[0].content).toBe(stripSystemCacheBreak(system));
      expect(String(systems[0].content)).not.toContain("⁣");
    }
  });
});
