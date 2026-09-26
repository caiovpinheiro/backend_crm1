import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import type { V2AgentConfig, V2CRMContext, V2LLMOutput } from "@/lib/ai-v2/types";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { v2FastAuxModel } from "@/lib/ai-v2/models";
import { lookupResultTexts, unsupportedFigures, unsupportedLongDates } from "../ground-reply";
import { applyNoSourceGuard, factsBackedBy, statesProcedure } from "../no-source";
import { parseClaimCheck, buildClaimCheckInput } from "../claim-check";
import { evaluateV2Rules } from "../rules";
import { announcesSending } from "../sent-materials";

const out = (reply: string): V2LLMOutput =>
  ({ reply, confirmed: null, handoff: false, concluded: false, outOfScope: false, sentiment: "neutral", collected: {}, reason: "", actions: [] }) as V2LLMOutput;
const ctx = { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } } as unknown as V2CRMContext;
const nothing = { searched: true, found: 0 };

const cfg = (extra: Record<string, unknown> = {}): V2AgentConfig =>
  normalizeV2Config({
    name: "Agente",
    tone: "Cordial",
    autonomyMode: "auto",
    handoff: { defaultDestination: { type: "department", id: "dep-1" }, message: "Vou chamar alguém da equipe." },
    ...extra,
  } as never);

describe("fontes além dos materiais", () => {
  it("resultado da busca de produtos vale como fonte do preço", () => {
    const calls = [
      { toolName: "search_products", result: { products: [{ name: "Camisa básica", price: 89.9, priceFormatted: "R$ 89,90" }] } },
      { toolName: "search_crm_records", result: { error: "falhou" } },
    ];
    const texts = lookupResultTexts(calls);
    expect(texts).toHaveLength(1);
    expect(unsupportedFigures("A camisa básica custa R$ 89,90.", texts)).toEqual([]);
    expect(unsupportedFigures("A camisa básica custa R$ 99,90.", texts)).toEqual(["R$ 99,90"]);
  });

  it("data por extenso: confere com a fonte em qualquer formato", () => {
    expect(unsupportedLongDates("Reabrimos em 6 de janeiro.", ["- 06/01/2027 — Reabertura"])).toEqual([]);
    expect(unsupportedLongDates("Reabrimos em 8 de janeiro.", ["- 06/01/2027 — Reabertura"])).toEqual(["8 de janeiro"]);
  });

  it("guarda 'sem material' aceita data do calendário e valor das informações fixas", () => {
    const now = new Date();
    const d = new Date(now.getTime() + 5 * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const br = `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
    const config = cfg({
      fallback: { noSource: { message: "Não tenho essa informação." } },
      calendar: { events: [{ id: "ev1", title: "Reabertura", start: iso }] },
      variables: [{ key: "taxa_entrega", value: "R$ 15" }],
    });
    const fromCalendar = out(`Reabrimos em ${br}.`);
    expect(applyNoSourceGuard({ config, output: fromCalendar, context: ctx, toolCalls: [], queriedEmpty: false, prefetch: nothing }).applied).toBe(false);
    const fromVariable = out("A taxa de entrega é R$ 15.");
    expect(applyNoSourceGuard({ config, output: fromVariable, context: ctx, toolCalls: [], queriedEmpty: false, prefetch: nothing }).applied).toBe(false);
    const invented = out("A taxa de entrega é R$ 25.");
    expect(applyNoSourceGuard({ config, output: invented, context: ctx, toolCalls: [], queriedEmpty: false, prefetch: nothing }).applied).toBe(true);
    expect(invented.reply).toBe("Não tenho essa informação.");
  });

  it("passo a passo, caminho e link: só material sustenta", () => {
    expect(statesProcedure("1. Abra o app\n2. Toque em Pedidos")).toBe(true);
    expect(statesProcedure("Acesse Conta > Pedidos")).toBe(true);
    expect(statesProcedure("A entrega leva 3 dias.")).toBe(false);
    expect(factsBackedBy("1. Em 3 dias abra o app", ["3 dias"])).toBe(false);
  });
});

describe("checagem por modelo", () => {
  it("aceita trecho parafraseado e descarta o que não está na resposta", () => {
    const reply = "A instalação é gratuita e o técnico vai até você em até 3 dias.";
    const text = JSON.stringify({ unsupported: ["instalação gratuita", "técnico vai até você em 3 dias", "reembolso em dobro"] });
    expect(parseClaimCheck(text, reply)).toEqual(["instalação gratuita", "técnico vai até você em 3 dias"]);
  });

  it("o que o agente já disse vai como contexto, não como fonte", () => {
    const input = buildClaimCheckInput({ reply: "r", sources: ["fonte"], clientTexts: ["oi"], agentHistory: ["A taxa é R$ 10."] });
    const [sources, rest] = input.split("O que o cliente disse");
    expect(sources).not.toContain("R$ 10");
    expect(rest).toContain("não é fonte; só para entender a conversa");
  });
});

describe("pedido de pessoa", () => {
  const config = cfg({
    rules: [{ id: "human_request", name: "Pedido de humano", order: 0, conditions: [{ type: "keywords", values: ["atendente"] }], actions: [{ type: "handoff" }] }],
  });
  const input = (userMessage: string) => ({ userMessage, isFirstMessage: false, withinBusinessHours: true });

  it("palavra solta vale em mensagem curta", () => {
    expect(evaluateV2Rules(config, input("atendente"), ctx)?.id).toBe("human_request");
    expect(evaluateV2Rules(config, input("quero um atendente"), ctx)?.id).toBe("human_request");
  });

  it("em frase, só frases de pedido; o resto o modelo decide", () => {
    expect(evaluateV2Rules(config, input("a atendente de ontem disse que o prazo era outro"), ctx)).toBeNull();
    expect(evaluateV2Rules(config, input("por favor eu quero falar com um atendente agora"), ctx)?.id).toBe("human_request");
  });
});

describe("tarefas auxiliares e anexos", () => {
  it("dentro do turno, modelo sem raciocínio", () => {
    expect(v2FastAuxModel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(v2FastAuxModel("gpt-5.6-sol")).toBe("gpt-4.1-mini");
    expect(v2FastAuxModel("claude-sonnet-5")).toBe("gpt-4.1-mini");
  });

  it("resposta que anuncia um envio", () => {
    expect(announcesSending("Segue o vídeo com o passo a passo.")).toBe(true);
    expect(announcesSending("Vou te enviar o material.")).toBe(true);
    expect(announcesSending("O prazo é de 3 dias.")).toBe(false);
  });
});
