import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn() }));
vi.mock("../tools", () => ({ searchV2Knowledge: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import type { V2AgentConfig, V2CRMContext, V2LLMOutput } from "@/lib/ai-v2/types";
import { renderMessage } from "@/lib/ai-v2/message-render";
import { unsupportedFacts, unsupportedMenuPaths, unsupportedQuotedTerms } from "../ground-reply";
import { applyNoSourceGuard } from "../no-source";
import { classifyPostCloseMessage } from "../closure";
import { selectV2Theme } from "../themes";

const out = (reply: string): V2LLMOutput =>
  ({ reply, confirmed: null, handoff: false, concluded: false, outOfScope: false, sentiment: "neutral", collected: {}, reason: "", actions: [] }) as V2LLMOutput;
const ctx = (contact: Record<string, unknown> | null = null): V2CRMContext =>
  ({ contact, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } }) as V2CRMContext;
const cfg = (extra: Record<string, unknown> = {}) =>
  ({ handoff: { message: "Vou chamar alguém da equipe." }, fallback: {}, themes: [], ...extra }) as unknown as V2AgentConfig;

describe("e-mail na mensagem não é variável", () => {
  it("mantém o e-mail e resolve a variável", () => {
    expect(renderMessage("Escreva para suporte@empresa.com.br, @Nome.", { Nome: "Ana" })).toBe("Escreva para suporte@empresa.com.br, Ana.");
    expect(renderMessage("garantia@empresa-exemplo.com.br", {})).toBe("garantia@empresa-exemplo.com.br");
  });
});

describe("checagem ampliada", () => {
  it("prazo, data, telefone e e-mail sem fonte", () => {
    const reply = "Chega em 15 dias úteis, até 30/11. Ligue (11) 3333-4444 ou escreva para vendas@loja.com.";
    expect(unsupportedFacts(reply, ["Prazo de entrega: 3 dias úteis."])).toEqual(
      expect.arrayContaining(["15 dias úteis", "30/11", "(11) 3333-4444", "vendas@loja.com"]),
    );
    expect(unsupportedFacts(reply, ["Entrega em 15 dias úteis, até 30/11. Telefone 11 3333 4444. E-mail vendas@loja.com"])).toEqual([]);
  });

  it("data da fonte em outro formato vale", () => {
    expect(unsupportedFacts("A loja abre em 5/10.", ['{"inicio":"2026-10-05"}'])).toEqual([]);
    expect(unsupportedFacts("A loja abre em 05/10/2026.", ["Reabertura: 5/10/26."])).toEqual([]);
  });

  it("caminho de tela sem aspas é conferido", () => {
    const src = ["Para trocar a senha, acesse Minha conta > Segurança. Confirme o e-mail."];
    expect(unsupportedMenuPaths("Acesse Configurações > Integrações > Planilhas.", src)).toEqual(["Configurações", "Integrações", "Planilhas"]);
    expect(unsupportedMenuPaths("1. Abra o app e toque em Minha conta > Segurança.", src)).toEqual([]);
  });

  it("radical curto não conta como o mesmo nome", () => {
    expect(unsupportedQuotedTerms('Vá em "Configurações".', ["Confirme o e-mail."])).toEqual(["Configurações"]);
    expect(unsupportedQuotedTerms('Toque em "Esqueci a senha".', ["Toque em Esqueci minha senha."])).toEqual([]);
  });
});

describe("guarda 'sem material'", () => {
  const nothing = { searched: true, found: 0 };

  it("nada nos materiais e resposta com fato → mensagem configurada, mesmo com contato conhecido", () => {
    const o = out("A instalação leva 2 dias.");
    const r = applyNoSourceGuard({ config: cfg({ fallback: { noSource: { message: "Não tenho essa informação." } } }), output: o, context: ctx({ Nome: "Ana" }), toolCalls: [], queriedEmpty: false, prefetch: nothing });
    expect(r).toEqual({ applied: true, handoff: false });
    expect(o.reply).toBe("Não tenho essa informação.");
  });

  it("sem mensagem configurada → transfere", () => {
    const o = out("1. Abra o app\n2. Toque em Pedidos");
    expect(applyNoSourceGuard({ config: cfg(), output: o, context: ctx({ Nome: "Ana" }), toolCalls: [], queriedEmpty: false, prefetch: nothing })).toEqual({ applied: true, handoff: true });
  });

  it("modelo já transfere e a explicação afirma fato sem material → só o aviso configurado sai", () => {
    const o = { ...out("O prazo de análise é de 5 dias úteis. Vou chamar alguém da equipe."), handoff: true };
    const r = applyNoSourceGuard({ config: cfg(), output: o, context: ctx({ Nome: "Ana" }), toolCalls: [], queriedEmpty: false, prefetch: nothing });
    expect(r).toEqual({ applied: true, handoff: true, explanationDropped: true });
    expect(o.reply).toBe("Vou chamar alguém da equipe.");
    const plain = { ...out("Entendi, vou chamar alguém da equipe para ver isso com você."), handoff: true };
    expect(applyNoSourceGuard({ config: cfg(), output: plain, context: ctx({ Nome: "Ana" }), toolCalls: [], queriedEmpty: false, prefetch: nothing }).applied).toBe(false);
    expect(plain.reply).toBe("Entendi, vou chamar alguém da equipe para ver isso com você.");
  });

  it("cortesia, dado do próprio cliente ou material encontrado: não mexe", () => {
    const base = { config: cfg(), context: ctx({ Nome: "Ana", Plano: "Fibra 500 Mega" }), toolCalls: [], queriedEmpty: false };
    expect(applyNoSourceGuard({ ...base, output: out("Por nada, Ana!"), prefetch: nothing }).applied).toBe(false);
    expect(applyNoSourceGuard({ ...base, output: out("Seu plano é Fibra 500 Mega, com 500 horas de suporte."), prefetch: nothing }).applied).toBe(false);
    expect(applyNoSourceGuard({ ...base, output: out("Chega em 3 dias úteis."), prefetch: { searched: true, found: 2, bestSimilarity: 0.7 } }).applied).toBe(false);
  });
});

describe("pós-encerramento e assuntos", () => {
  it("pergunta com conteúdo depois de encerrar é pedido", () => {
    expect(classifyPostCloseMessage(cfg(), "oi, a garantia cobre queda?")).toBe("new_demand");
    expect(classifyPostCloseMessage(cfg(), "obrigado!")).toBe("courtesy");
    expect(classifyPostCloseMessage(cfg(), "oi")).toBe("ambiguous");
  });

  it("empate de gatilhos: vence o mais específico", () => {
    const themes = [
      { id: "marcar", name: "Marcar", when: ["consulta"], examples: [] },
      { id: "desmarcar", name: "Desmarcar", when: ["desmarcar"], examples: [] },
    ];
    expect(selectV2Theme(cfg({ themes }), "quero desmarcar a consulta")?.id).toBe("desmarcar");
    expect(selectV2Theme(cfg({ themes }), "quero marcar uma consulta")?.id).toBe("marcar");
  });
});
