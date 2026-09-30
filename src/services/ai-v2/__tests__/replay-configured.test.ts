import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { buildEvaluatorInput, configuredTexts, inventionIsConfigured, pointWhy } from "../replay";

const config = {
  handoff: { message: "Vou te passar para o time Alfa", queuedMessage: "" },
  fallback: { noSource: { message: "Não consegui encontrar uma resposta segura." } },
  closure: { goodbyeMessage: "Que bom que consegui te ajudar!" },
  replyEnding: { info: { enabled: true, phrases: ["Posso te ajudar em mais alguma coisa? Caso eu não receba uma resposta nos próximos 30 minutos, vou encerrar este atendimento por aqui."] } },
  themes: [{ id: "t", name: "Saída", handoffDestination: { type: "ai_agent", id: "a2", message: "Vou te passar para o time Beta." } }],
} as never;

describe("comparador — textos configurados e porquê", () => {
  it("textos fixos da empresa vão para o avaliador e não contam como invenção", () => {
    const fixed = configuredTexts(config);
    expect(fixed).toEqual(expect.arrayContaining(["Vou te passar para o time Alfa", "Vou te passar para o time Beta."]));
    expect(inventionIsConfigured("time Alfa", fixed)).toBe(true);
    expect(inventionIsConfigured("encerrará o atendimento após 30 minutos sem resposta", fixed)).toBe(true);
    expect(inventionIsConfigured("taxa de R$ 99,00 por pedido", fixed)).toBe(false);
    const input = buildEvaluatorInput({ point: { index: 0, at: "", clientText: "oi", humanText: "olá", history: [] } as never, agentReply: "x", agentHandoff: false, sources: [], fixedTexts: fixed });
    expect(input).toContain("TEXTOS FIXOS DA EMPRESA:");
  });

  it("porquê do ponto: decisão, causa, destino e passos-chave", () => {
    const why = pointWhy({ reason: "Faltou material", handoffCause: "verification", forwardedTo: null, trace: [{ step: "entrada", detail: "x" }, { step: "verificação", detail: "Resposta cita R$ 99" }] });
    expect(why).toEqual({ reason: "Faltou material", cause: "verification", forwardedTo: null, steps: ["verificação: Resposta cita R$ 99"] });
    expect(pointWhy(null)).toBeNull();
  });
});
