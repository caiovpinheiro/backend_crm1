/**
 * Peso do bloco de base de conhecimento no prompt.
 *
 * Medição do prompt real: 22 ocorrências de "distribu*", 8 de "Retenção",
 * 5 de "NA HORA" — contra uma única linha pedindo para "fundamentar" a
 * resposta nas referências. O conteúdo recuperado perdia a disputa e o
 * agente encaminhava assunto que estava documentado na base.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/services/ai/provider", () => ({ embedTexts: vi.fn() }));

import {
  formatRetrievalBlock,
  KNOWLEDGE_PRECEDENCE_RULE,
} from "@/services/ai/retrieval";

const chunk = {
  id: "chunk-1",
  docId: "doc-1",
  docTitle: "Como cancelar o contrato",
  content: "O cancelamento é pedido no portal, aba Meus Pedidos.",
  distance: 0.12,
};

describe("formatRetrievalBlock", () => {
  it("declara precedência das referências sobre transferir", () => {
    const block = formatRetrievalBlock([chunk]);

    expect(block).toContain(KNOWLEDGE_PRECEDENCE_RULE);
    expect(block).toContain("PRECEDÊNCIA");
    expect(block).toMatch(/não transfira nem encaminhe/);
    // Continua trazendo o conteúdo e a citação numerada.
    expect(block).toContain("[1] Como cancelar o contrato");
    expect(block).toContain(chunk.content);
  });

  it("a regra vem depois das referências, no fim do bloco", () => {
    const block = formatRetrievalBlock([chunk]);
    expect(block.indexOf(chunk.content)).toBeLessThan(
      block.indexOf(KNOWLEDGE_PRECEDENCE_RULE),
    );
    expect(block.trimEnd().endsWith(KNOWLEDGE_PRECEDENCE_RULE)).toBe(true);
  });

  it("sem trecho recuperado não entra nada no prompt", () => {
    expect(formatRetrievalBlock([])).toBe("");
  });

  it("é curta e genérica — o prompt já é grande", () => {
    expect(KNOWLEDGE_PRECEDENCE_RULE.split("\n")).toHaveLength(1);
    expect(KNOWLEDGE_PRECEDENCE_RULE.length).toBeLessThan(200);
    for (const vertical of [
      "aluno",
      "matrícula",
      "curso",
      "polo",
      "retenção",
      "acolhimento",
    ]) {
      expect(KNOWLEDGE_PRECEDENCE_RULE.toLowerCase()).not.toContain(vertical);
    }
  });
});
