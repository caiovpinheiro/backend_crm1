import { describe, expect, it } from "vitest";

import { sourcesFromToolCalls } from "../sources";

describe("sourcesFromToolCalls", () => {
  it("junta trechos da pré-busca e das buscas do modelo, sem repetir, com a similaridade", () => {
    const sources = sourcesFromToolCalls([
      { toolName: "knowledge_search", args: { prefetch: true }, result: { chunks: [{ docTitle: "A", content: "texto A", distance: 0.4 }] } },
      { toolName: "knowledge_search", args: { query: "q" }, result: { chunks: [
        { docTitle: "A", content: "texto A", distance: 0.3 },
        { docTitle: "B", content: "texto B", distance: 0.5 },
      ] } },
      { toolName: "search_products", result: { products: [] } },
    ]);
    expect(sources).toEqual([
      { title: "A", content: "texto A", similarity: 0.7 },
      { title: "B", content: "texto B", similarity: 0.5 },
    ]);
  });

  it("sem chamadas → nada", () => {
    expect(sourcesFromToolCalls(undefined)).toEqual([]);
  });
});
