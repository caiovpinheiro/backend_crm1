import { describe, expect, it } from "vitest";

import { saysTriedAndFailed } from "../retry-signal";

describe("já tentei e não deu certo", () => {
  it("tentativa + falha", () => {
    for (const t of [
      "Ja fiz 3 tentativas e da indeferimento",
      "Ja tentei 3 vezes não ta dando deferimento",
      "já tentei e não funcionou",
      "Fiz tudo isso e continua dando erro",
      "tentei de novo e deu o mesmo erro",
      "refiz o cadastro e foi recusado de novo",
      "Já enviei duas vezes e nada aconteceu",
      "3 tentativas e nada",
    ]) {
      expect(saysTriedAndFailed(t), t).toBe(true);
    }
  });

  it("falha com repetição, sem dizer 'tentei'", () => {
    for (const t of ["continua sem funcionar", "deu erro de novo", "ainda não aparece", "mesmo problema"]) {
      expect(saysTriedAndFailed(t), t).toBe(true);
    }
  });

  it("não conta: pedido novo, pergunta, confirmação, falha isolada sem repetição", () => {
    for (const t of [
      "Não estou conseguindo deferimento no estágio",
      "e se não der certo?",
      "Estar tudo correto",
      "ok obrigado",
      "não funcionou",
      "quero cancelar",
      "como faço para solicitar?",
    ]) {
      expect(saysTriedAndFailed(t), t).toBe(false);
    }
  });
});
