import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn(), embedTexts: vi.fn() }));

import { closingStepOf, endsWithStep } from "../llm";

describe("passo final da resposta (rodada 5, 27/11)", () => {
  it("acha a pergunta ou o \"me avisa por aqui\" do fim; sem número, valor nem link", () => {
    expect(closingStepOf("A mensalidade tem reajuste anual. Ficou mais alguma dúvida ou seguimos para garantir sua vaga?")).toBe("Ficou mais alguma dúvida ou seguimos para garantir sua vaga?");
    expect(closingStepOf("Combinado, sem pressa. Quando decidir, me avisa por aqui.")).toBe("Quando decidir, me avisa por aqui.");
    expect(closingStepOf("A taxa é R$ 99. Fica R$ 99 por mês?")).toBeNull();
    expect(closingStepOf("O que achou?")).toBeNull();
    expect(closingStepOf("A aula começa em fevereiro. Até lá.")).toBeNull();
  });

  it("resposta que já termina em passo não ganha outro", () => {
    expect(endsWithStep("Pode encaminhar esse resumo pra ele.")).toBe(false);
    expect(endsWithStep("Pode encaminhar esse resumo pra ele. Quer que eu te chame amanhã?")).toBe(true);
    expect(endsWithStep("Qualquer coisa, me chama aqui.")).toBe(true);
  });
});
