import { describe, expect, it } from "vitest";

import { looksLikeSystemError, saysTriedAndFailed } from "../retry-signal";

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

describe("mensagem de erro da tela colada pelo cliente", () => {
  it("voz de sistema conta como tentativa que falhou", () => {
    for (const t of [
      "Não localizamos os dados informados. Tente novamente.",
      "Usuário ou senha inválidos",
      "Ocorreu um erro ao processar sua solicitação",
      "Acesso negado",
      "Código inválido. Verifique os dados e tente novamente.",
      "Sessão expirada",
    ]) {
      expect(looksLikeSystemError(t), t).toBe(true);
    }
  });

  it("fala do cliente não conta", () => {
    for (const t of ["quero cancelar", "como faço para acessar?", "ok obrigado", "não consegui", "e se der erro?"]) {
      expect(looksLikeSystemError(t), t).toBe(false);
    }
  });
});
