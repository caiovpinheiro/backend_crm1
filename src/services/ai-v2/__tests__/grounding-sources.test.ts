import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import type { V2AgentConfig, V2CRMContext, V2LLMOutput } from "@/lib/ai-v2/types";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { v2FastAuxModel } from "@/lib/ai-v2/models";
import { lookupResultTexts, unsupportedFigures, unsupportedLongDates } from "../ground-reply";
import { answersBeforeHandoff, applyNoSourceGuard, factsBackedBy, statesProcedure } from "../no-source";
import { businessHoursText } from "../rules";
import { isHumanRequestTheme } from "@/lib/ai-v2/config";
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

describe("teste do agente pelo WhatsApp", () => {
  it("valor que o cliente escreveu sem R$ pode ser repetido com R$", () => {
    const client = ["Não entendi, falaram de 129 mas o boleto esta 1000"];
    expect(unsupportedFigures("Você citou R$ 129 e o boleto veio R$ 1.000.", [], client)).toEqual([]);
    expect(unsupportedFigures("Você citou R$ 129 e o boleto veio R$ 1.000.", [])).toEqual(["R$ 129", "R$ 1.000"]);
    expect(unsupportedFigures("A taxa é R$ 50.", [], client)).toEqual(["R$ 50"]);
  });

  it("horário de atendimento configurado vira texto (prompt e fonte)", () => {
    const text = businessHoursText({ businessHours: { enabled: true, timezone: "America/Sao_Paulo", weekdays: [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "18:00" })) } } as never);
    expect(text).toContain("segunda-feira: 08:00 às 18:00");
    expect(text).toContain("domingo: sem atendimento");
    expect(businessHoursText({ businessHours: { enabled: false, timezone: "America/Sao_Paulo", weekdays: [] } } as never)).toBe("");
  });

  it("assunto que só repete o pedido de pessoa", () => {
    const config = cfg({ handoff: { defaultDestination: { type: "department", id: "d" }, message: "x", humanRequestKeywords: ["atendente", "humano"] } });
    expect(isHumanRequestTheme({ when: ["atendente", "humano", "falar com uma pessoa"] }, config)).toBe(true);
    expect(isHumanRequestTheme({ when: ["boleto", "mensalidade", "atendente"] }, config)).toBe(false);
  });

  it("orientação antes da transferência só quando há conteúdo além do aviso", () => {
    expect(answersBeforeHandoff("Vou te passar para o time do financeiro.")).toBe(false);
    expect(answersBeforeHandoff("O boleto pode mostrar o valor integral antes dos descontos; confira o desconto e a data limite no corpo do boleto. Vou te encaminhar ao financeiro para conferir o seu caso.")).toBe(true);
    expect(answersBeforeHandoff("Não tenho essa informação aqui, mas a equipe consegue te ajudar com isso rapidinho.")).toBe(false);
  });
});
