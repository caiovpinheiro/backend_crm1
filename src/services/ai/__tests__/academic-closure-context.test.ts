/**
 * Encerramento por contexto: o gatilho é a DESPEDIDA do agente somada à
 * última fala do aluno. Casos reais da fila acadêmica:
 *  - David: agente entrega o passo a passo → "Ok" → agente se despede.
 *    Tinha que encerrar; ficava aberto e ainda recebia follow-up.
 *  - Brena: "Não, muito obrigada" → despedida → encerrou (referência).
 *
 * As funções aqui são puras (regex), então testamos sem prisma.
 */
import { describe, expect, it } from "vitest";

import {
  agentReplyLooksLikeFarewell,
  shouldCloseAfterAgentFarewell,
  userAcknowledgedAndClosed,
  userDefersUntilLater,
} from "@/services/ai/academic-closure";

const FAREWELL =
  "Beleza, David! Se precisar de mais alguma coisa, é só chamar aqui. Boa tarde pra você! 😊";

describe("userAcknowledgedAndClosed", () => {
  it("aceite curto conta como aceite", () => {
    for (const msg of [
      "Ok",
      "ok!",
      "Tá bom obrigado",
      "beleza, entendi",
      "Perfeito, muito obrigada",
      "valeu 👍",
    ]) {
      expect(userAcknowledgedAndClosed(msg), msg).toBe(true);
    }
  });

  it("pergunta, pedido ou assunto novo não é aceite", () => {
    for (const msg of [
      "Ok, e como faço pra pagar?",
      "ok, me manda o link",
      "ok mas não consegui entrar",
      "Preciso sim, por favor",
      "Tenho ou não material pra estudo?",
    ]) {
      expect(userAcknowledgedAndClosed(msg), msg).toBe(false);
    }
  });
});

describe("userDefersUntilLater", () => {
  it("pega o adiamento com verbo depois do horário", () => {
    expect(userDefersUntilLater("mais tarde entro em contato")).toBe(true);
    expect(userDefersUntilLater("amanhã eu retorno")).toBe(true);
    expect(userDefersUntilLater("te procuro depois")).toBe(true);
  });
});

describe("shouldCloseAfterAgentFarewell", () => {
  it("caso David: aceite + despedida do agente encerra", () => {
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage: "Ok",
        replyText: FAREWELL,
      }),
    ).toBe(true);
  });

  it("caso Brena: agradecimento + despedida encerra", () => {
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage: "Não, muito obrigada",
        replyText:
          "Por nada! Qualquer dúvida depois é só chamar, tá? Tenha uma boa tarde 😊",
      }),
    ).toBe(true);
  });

  it("resposta do agente que ainda pergunta não encerra", () => {
    expect(agentReplyLooksLikeFarewell("Quer que eu te explique como acessar?")).toBe(
      false,
    );
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage: "Ok",
        replyText: "Quer que eu te explique como acessar o Blackboard?",
      }),
    ).toBe(false);
  });

  it("aluno com pendência não encerra nem com despedida", () => {
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage: "ok, mas ainda não consegui acessar",
        replyText: FAREWELL,
      }),
    ).toBe(false);
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage: "quero falar com um atendente",
        replyText: FAREWELL,
      }),
    ).toBe(false);
  });
});
