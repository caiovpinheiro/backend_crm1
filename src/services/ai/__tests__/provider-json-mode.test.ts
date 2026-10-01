import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

/**
 * Modo JSON: o pedido que chega ao modelo leva `responseFormat: json`, e o
 * texto volta para quem chama sem validação do SDK (quem valida é o motor).
 */

const seen: Array<{ responseFormat?: unknown }> = [];
const mockModel = new MockLanguageModelV3({
  doGenerate: async (options) => {
    seen.push({ responseFormat: options.responseFormat });
    return {
      content: [{ type: "text", text: "isto não é JSON" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    } as any;
  },
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => mockModel }));

import { generateWithTools } from "../provider";

describe("generateWithTools — modo JSON", () => {
  it("pede JSON à API só quando ligado e devolve o texto sem lançar erro", async () => {
    seen.length = 0;
    const off = await generateWithTools({ model: "m", apiKey: "k", system: "s", messages: [{ role: "user", content: "oi" }] });
    const on = await generateWithTools({ model: "m", apiKey: "k2", system: "s", messages: [{ role: "user", content: "oi" }], jsonMode: true });
    expect(seen[0].responseFormat).toBeUndefined();
    expect(seen[1].responseFormat).toEqual({ type: "json" });
    expect(off.text).toBe("isto não é JSON");
    expect(on.text).toBe("isto não é JSON");
  });
});
