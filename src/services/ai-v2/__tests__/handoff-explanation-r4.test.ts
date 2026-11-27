import { describe, expect, it } from "vitest";

import { handoffExplanation } from "../no-source";

describe("explicação antes da transferência (rodada 4, 27/11)", () => {
  it("resposta que já fecha com a passagem vai inteira, com o acolhimento da regra (POS8-06)", () => {
    const reply = "Entendo sua frustração. Anotei seu pedido de cancelamento e de reembolso, e alguém da equipe te responde por aqui.";
    expect(handoffExplanation(reply)).toBe(reply);
  });

  it("acolhimento do que a pessoa sente fica; cortesia vazia continua saindo", () => {
    expect(handoffExplanation("Entendo sua chateação, e sinto por isso. Vou te passar para a equipe.")).toBe("Entendo sua chateação, e sinto por isso.");
    expect(handoffExplanation("Entendo a dúvida. Vou te passar para a equipe.")).toBe("");
  });

  it("pedido ao cliente com \"que eu passo pra equipe\": o pedido fica (POS6-02)", () => {
    expect(handoffExplanation("Entendi, o pagamento que você fez ainda aparece como pendente. Me manda um print do comprovante que eu passo pra equipe conferir."))
      .toBe("Entendi, o pagamento que você fez ainda aparece como pendente. Me manda um print do comprovante.");
  });
});
