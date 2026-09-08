import { describe, expect, it } from "vitest";

import { chunkText } from "@/services/ai/embeddings";
import { reconstructContentFromChunks } from "@/services/ai/knowledge-docs";

/**
 * Docs indexados antes da coluna `content` só existem como chunks, que se
 * sobrepõem em ~300 chars. Concatenar cru duplicaria trechos e o operador
 * salvaria um documento corrompido ao editar.
 */
describe("reconstructContentFromChunks", () => {
  it("sintoma original: chunks com overlap não podem ser concatenados crus", () => {
    const original = Array.from(
      { length: 40 },
      (_, i) => `Parágrafo ${i}: ${"conteúdo de teste ".repeat(12)}fim.`,
    ).join("\n\n");

    const chunks = chunkText(original);
    expect(chunks.length).toBeGreaterThan(1);

    const naive = chunks.map((c) => c.content).join("");
    const rebuilt = reconstructContentFromChunks(chunks);

    expect(naive.length).toBeGreaterThan(original.length);
    expect(rebuilt).toBe(original);
  });

  it("documento de um chunk só volta idêntico", () => {
    const original = "FAQ curta do agente.";
    expect(reconstructContentFromChunks(chunkText(original))).toBe(original);
  });

  it("sem chunks devolve string vazia", () => {
    expect(reconstructContentFromChunks([])).toBe("");
  });

  it("ordena pela posição, não pela ordem de leitura do banco", () => {
    const chunks = [
      { content: "segunda parte", position: 10 },
      { content: "primeira parte", position: 0 },
    ];
    expect(reconstructContentFromChunks(chunks)).toBe(
      "primeira parte\n\nsegunda parte",
    );
  });
});
