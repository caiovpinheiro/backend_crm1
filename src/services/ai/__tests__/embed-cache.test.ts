import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ embedMany: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), embedMany: mocks.embedMany }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => Object.assign(() => ({}), { textEmbeddingModel: () => "embedding-model" }) }));
vi.mock("@/services/ai/llm-retry", () => ({ callLlmWithRetry: (fn: (signal?: AbortSignal) => Promise<unknown>) => fn(undefined) }));

import { clearEmbedCache, embedTexts } from "../provider";

describe("embedTexts — vetor por texto reaproveitado dentro do turno", () => {
  beforeEach(() => {
    clearEmbedCache();
    mocks.embedMany.mockReset();
    mocks.embedMany.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: values.map((v) => [v.length, 1]),
      usage: { tokens: values.length },
    }));
  });

  it("só embeda o que ainda não tem vetor e devolve na ordem pedida", async () => {
    const first = await embedTexts(["quero a segunda via da fatura", "prazo de entrega"], "k");
    expect(first.embeddings).toEqual([[29, 1], [16, 1]]);
    expect(mocks.embedMany).toHaveBeenCalledTimes(1);

    const second = await embedTexts(["prazo de entrega", "quero a segunda via da fatura", "troca de produto"], "k");
    expect(mocks.embedMany).toHaveBeenCalledTimes(2);
    expect(mocks.embedMany.mock.calls[1][0].values).toEqual(["troca de produto"]);
    expect(second.embeddings).toEqual([[16, 1], [29, 1], [16, 1]]);
    expect(second.inputTokens).toBe(1);
  });

  it("tudo em cache: não chama a API", async () => {
    await embedTexts(["prazo de entrega"], "k");
    const r = await embedTexts(["prazo de entrega"], "k");
    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
    expect(r.embeddings).toEqual([[16, 1]]);
    expect(r.inputTokens).toBe(0);
  });
});
