import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { EMPTY_EXPORT_NAMES, buildAgentRulesMarkdown, detectConfigGaps, type V2ExportNames } from "../rules-export";

const names: V2ExportNames = {
  ...EMPTY_EXPORT_NAMES,
  departments: { "dep-1": "Atendimento" },
  aiAgents: { "ag-old": { name: "Agente Antigo", engine: "legacy", active: true } },
  docs: { "doc-1": { title: "Prazos de entrega", status: "READY", validUntil: null, attachments: 2 } },
  customFields: { "cf-doc": "CPF" },
};

const cfg = (extra: Record<string, unknown> = {}) =>
  normalizeV2Config({
    name: "Agente",
    tone: "Cordial",
    allowedKnowledgeDocIds: ["doc-1"],
    themes: [
      { id: "t1", name: "Entrega", when: ["prazo"], examples: [], instructions: "Frete grátis acima de R$ 200.", handoffDestination: { type: "ai_agent", id: "ag-old" } },
      { id: "t2", name: "Troca", when: ["prazo", "trocar"], examples: [], instructions: "" },
    ],
    contextFields: { contact: [], deal: [{ key: "cf-doc", permissions: ["read", "cite"] }] },
    rules: [{ id: "human_request", name: "Pedido de humano", order: 0, conditions: [{ type: "keywords", values: ["pessoa"] }], actions: [{ type: "handoff" }] }],
    ...extra,
  } as never);

describe("exportação das regras", () => {
  it("aponta os gaps da configuração", () => {
    const gaps = detectConfigGaps(cfg(), names);
    const texts = gaps.map((g) => `${g.level}|${g.text}`).join("\n");
    expect(texts).toContain("alta|Sem mensagem para quando nada nos materiais responde");
    expect(texts).toContain("Gatilho “prazo” em mais de um assunto (Entrega, Troca)");
    expect(texts).toContain("Instruções de “Entrega” têm valor, data ou prazo");
    expect(texts).toContain("transfere para Agente Antigo, do motor antigo");
    expect(texts).toContain("Campo “CPF” (negócio) pode ser dito inteiro");
    expect(texts).toContain("Pedido de pessoa por palavra solta");
    // Ordem: alta antes de média antes de baixa.
    const levels = gaps.map((g) => g.level);
    expect(levels.indexOf("alta")).toBeLessThan(levels.lastIndexOf("baixa"));
  });

  it("gera a ficha com nomes no lugar dos ids", () => {
    const md = buildAgentRulesMarkdown({ config: cfg({ fallback: { noSource: { message: "Não tenho essa informação." } } }), names, agentName: "Agente", version: "publicada v3", generatedAt: new Date("2026-09-26T12:00:00Z") });
    expect(md).toContain("# Regras do agente Agente");
    expect(md).toContain("Versão: publicada v3");
    expect(md).toContain("## Pontos de atenção");
    expect(md).toContain("Materiais gerais: Prazos de entrega (2 anexo(s))");
    expect(md).toContain("### Entrega");
    expect(md).toContain("Transferência: agente de IA Agente Antigo (motor antigo)");
    expect(md).toContain("- CPF (negócio): Usar/Dizer");
    expect(md).toContain("**Pedido de humano**");
    expect(md).not.toContain("Sem mensagem para quando nada nos materiais responde");
  });
});
