import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { EMPTY_EXPORT_NAMES, buildAgentRulesMarkdown, detectConfigGaps, type V2ExportNames } from "../rules-export";

const names: V2ExportNames = {
  ...EMPTY_EXPORT_NAMES,
  departments: { "dep-1": "Atendimento" },
  aiAgents: { "ag-old": { name: "Agente Antigo", engine: "legacy", active: true }, "ag-self": { name: "Este", engine: "simple", active: true } },
  docs: { "doc-1": { title: "Prazos de entrega", status: "READY", validUntil: null, attachments: 2 } },
  customFields: { "cf-doc": "CPF" },
  tabulations: { "tab-1": "Atendimento › Entrega" },
};

const cfg = (extra: Record<string, unknown> = {}) =>
  normalizeV2Config({
    name: "Agente",
    tone: "Cordial",
    autonomyMode: "auto",
    allowedKnowledgeDocIds: ["doc-1"],
    themes: [
      { id: "t1", name: "Entrega", when: ["prazo"], examples: [], instructions: "Frete grátis acima de R$ 200.", handoffDestination: { type: "ai_agent", id: "ag-old" } },
      { id: "t2", name: "Troca", when: ["prazo", "trocar"], examples: [], instructions: "Explique a troca." },
    ],
    contextFields: { contact: [], deal: [{ key: "cf-doc", permissions: ["read", "cite"] }] },
    rules: [{ id: "human_request", name: "Pedido de humano", order: 0, conditions: [{ type: "keywords", values: ["pessoa"] }], actions: [{ type: "handoff" }] }],
    handoff: { defaultDestination: { type: "department", id: "dep-1" }, message: "Vou transferir." },
    ...extra,
  } as never);

const gapTexts = (extra: Record<string, unknown> = {}, ctx = {}) => detectConfigGaps(cfg(extra), names, ctx).map((g) => `${g.level}|${g.text}`).join("\n");

describe("exportação das regras — pontos de atenção", () => {
  it("básicos: sem material configurado, gatilho repetido, instrução com valor, destino do motor antigo, pedido de pessoa", () => {
    const texts = gapTexts();
    expect(texts).toContain("alta|Sem mensagem para quando nada nos materiais responde");
    expect(texts).toContain("Gatilho “prazo” em mais de um assunto (Entrega, Troca)");
    expect(texts).toContain("Instruções de “Entrega” têm valor, data ou prazo");
    expect(texts).toContain("Assunto “Entrega” transfere para Agente Antigo, do motor antigo");
    expect(texts).toContain("baixa|Campo “CPF” (negócio) pode ser dito inteiro");
    expect(texts).toContain("Pedido de pessoa por palavra solta (pessoa");
    const gaps = detectConfigGaps(cfg(), names);
    expect(gaps[0].id).toBe("G-001");
    expect(gaps.map((g) => g.level).indexOf("alta")).toBeLessThan(gaps.map((g) => g.level).lastIndexOf("baixa"));
  });

  it("atalho sem condição nunca dispara; atalho escondido por outro", () => {
    const texts = gapTexts({
      rules: [
        { id: "r0", name: "Vazio", order: 0, conditions: [], actions: [{ type: "handoff" }] },
        { id: "r1", name: "Cancelar", order: 1, conditions: [{ type: "keywords", values: ["cancelar", "encerrar"] }], actions: [{ type: "handoff" }] },
        { id: "r2", name: "Cancelar plano", order: 2, conditions: [{ type: "keywords", values: ["cancelar"] }], actions: [{ type: "handoff" }] },
      ],
    });
    expect(texts).toContain("Atalho “Vazio” sem condição: nunca dispara");
    expect(texts).toContain("Atalho “Cancelar plano” nunca dispara: “Cancelar” vem antes");
  });

  it("tabulação por assunto gravada em byTheme conta; id inexistente é apontado", () => {
    const ok = gapTexts({ tabulation: { enabled: true, strategy: "fixed", byTheme: { t1: "tab-1" } } });
    expect(ok).not.toContain("Tabulação ligada sem tabulação escolhida");
    const bad = gapTexts({ tabulation: { enabled: true, strategy: "fixed", byTheme: { t1: "tab-x" } } });
    expect(bad).toContain("Tabulação do assunto “Entrega” não existe mais");
  });

  it("publicação: números de teste, modo sugestão só na publicada", () => {
    expect(gapTexts({ allowedPhoneNumbers: ["5511999990000"] })).toContain("alta|Lista de números de teste preenchida (1)");
    expect(gapTexts({ autonomyMode: "suggest" }, { version: "published" })).toContain("Modo sugestão");
    expect(gapTexts({ autonomyMode: "suggest" }, { version: "draft" })).not.toContain("Modo sugestão");
  });

  it("ferramentas do assunto com consulta sem busca nos materiais bloqueiam os materiais", () => {
    const texts = gapTexts({ themes: [{ id: "t1", name: "Cadastro", when: ["cadastro"], examples: [], instructions: "x", allowedTools: ["handoff", "search_crm_records"] }] });
    expect(texts).toContain("alta|Assunto “Cadastro”: a lista de ferramentas do assunto tem consulta mas não “Buscar nos materiais”");
  });

  it("transferências: destino apagado de qualquer tipo, para si mesmo, padrão sem escolha", () => {
    const texts = gapTexts(
      {
        themes: [{ id: "t1", name: "Vendas", when: ["comprar"], examples: [], instructions: "x", handoffDestination: { type: "department", id: "dep-x" } }],
        rules: [{ id: "r1", name: "Gerente", order: 0, conditions: [{ type: "keywords", values: ["gerente"] }], actions: [{ type: "handoff", destination: { type: "ai_agent", id: "ag-self" } }] }],
        handoff: { defaultDestination: { type: "department" }, message: "Vou transferir." },
      },
      { agentId: "ag-self" },
    );
    expect(texts).toContain("Assunto “Vendas” transfere para um(a) departamento que não existe mais");
    expect(texts).toContain("Atalho “Gerente” transfere para este mesmo agente");
    expect(texts).toContain("alta|Destino padrão de transferência sem departamento ou pessoa");
  });

  it("gatilhos: mesma palavra com outra flexão, gatilho que nunca casa, gatilho genérico", () => {
    const texts = gapTexts({
      themes: [
        { id: "a", name: "Cancelar", when: ["cancelar", "de a"], examples: [], instructions: "x" },
        { id: "b", name: "Planos", when: ["cancelamento", "ajuda"], examples: [], instructions: "y" },
      ],
    });
    expect(texts).toContain("Gatilhos “cancelar” (Cancelar) e “cancelamento” (Planos) contam como a mesma palavra");
    expect(texts).toContain("Gatilho “de a” de “Cancelar” nunca é reconhecido");
    expect(texts).toContain("Gatilho “ajuda” de “Planos” é genérico");
  });

  it("começo e fim: boas-vindas sem texto, inatividade invertida, campo gravado sem permissão", () => {
    const texts = gapTexts({
      entry: { openingEnabled: true, openingMessage: "", confirmContact: false },
      inactivity: { enabled: true, nudgeAfter: 60, closeAfter: 30 },
      closure: { fieldUpdates: [{ entity: "deal", key: "cf-doc", value: "ok" }] },
    });
    expect(texts).toContain("Boas-vindas ligadas sem mensagem");
    expect(texts).toContain("O aviso (60 min) vem depois do encerramento (30 min)");
    expect(texts).toContain("alta|Ao encerrar, o campo “CPF” não será gravado");
  });
});

describe("exportação das regras — ficha", () => {
  it("nomes e ids, como o motor decide, fidelidade de horário/sentimento/limites", () => {
    const md = buildAgentRulesMarkdown({
      config: cfg({
        fallback: { noSource: { message: "Não tenho essa informação." } },
        businessHours: { enabled: true, timezone: "America/Sao_Paulo", weekdays: [], outsideAction: "handoff" },
        sentiment: { enabled: true, threshold: "angry", action: "notify_and_continue" },
        tabulation: { enabled: true, strategy: "fixed", byTheme: { t1: "tab-1" } },
      }),
      names,
      agentName: "Agente",
      agentId: "ag-self",
      version: "publicada v3",
      generatedAt: new Date("2026-09-26T12:00:00Z"),
    });
    expect(md).toContain("Versão: publicada v3 · id: ag-self");
    expect(md).toContain("## Como o motor decide");
    expect(md).toContain("Materiais gerais: Prazos de entrega (2 anexo(s))");
    expect(md).toContain("### Entrega (id: t1)");
    expect(md).toContain("| Entrega | t1 | 1 | 0 | própria | Atendimento › Entrega |");
    expect(md).toContain("Tabulação: Atendimento › Entrega");
    expect(md).toContain("Transferência: agente de IA Agente Antigo (id: ag-old) (motor antigo)");
    expect(md).toContain("**Pedido de humano** (id: human_request)");
    expect(md).toContain("ligado sem dias → sempre aberto");
    expect(md).not.toContain("fora do horário: handoff");
    expect(md).toContain("continua atendendo (só registra)");
    expect(md).not.toContain("trocas sem avanço");
    expect(md).not.toContain("Sem mensagem para quando nada nos materiais responde");
  });

  it("configuração mínima recebe os padrões (limites, entrada, encerramento)", () => {
    const c = normalizeV2Config({ name: "A", tone: "t" } as never);
    expect(c.limits.maxLoopCount).toBe(3);
    expect(c.closure.postCloseWindowHours).toBe(6);
    expect(c.entry.onDealNotFound).toBe("ask_identification");
    expect(c.media.audio.action).toBe("handoff");
  });
});
