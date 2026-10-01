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

import { getVerticalPack } from "@/verticals";

const {
  agentReplyLooksLikeFarewell,
  shouldCloseAfterAgentFarewell,
  shouldCloseAiAfterStudentMessage,
  studentWrappedUp,
  userAcknowledgedAndClosed,
  userDefersUntilLater,
  userSaysGoodbye,
  userSaysThatsAll,
  userThanksInSentence,
} = getVerticalPack("academic")!.ops as Record<
  string,
  (...args: any[]) => any
>;
import { userWantsSoftAiClose } from "@/services/ai/idle-followup";

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

describe("userThanksInSentence", () => {
  it("agradecimento comentando o resultado encerra", () => {
    expect(
      userThanksInSentence("Ficou bom, usarei esse exemplo como base. Obrigado"),
    ).toBe(true);
    expect(userThanksInSentence("Ajudou muito, valeu!")).toBe(true);
  });

  it("agradecimento com pendência ou pergunta não encerra", () => {
    expect(userThanksInSentence("Obrigado, mas o link não abre")).toBe(false);
    expect(userThanksInSentence("Obrigado! E sobre a prova, como acesso?")).toBe(
      false,
    );
    expect(userThanksInSentence("Obrigado, mas preciso falar com um consultor")).toBe(
      false,
    );
  });
});

describe("userSaysGoodbye", () => {
  it("retribuição de despedida encerra", () => {
    expect(
      userSaysGoodbye(
        "Desejo o mesmo, uma ótima tarde pra você também, boa quarta-feira!",
      ),
    ).toBe(true);
    expect(userSaysGoodbye("Igualmente!")).toBe(true);
    expect(userSaysGoodbye("Até mais")).toBe(true);
    expect(userSaysGoodbye("Bom fim de semana")).toBe(true);
  });

  it("saudação de abertura não é despedida", () => {
    expect(userSaysGoodbye("Boa tarde")).toBe(false);
    expect(userSaysGoodbye("Bom dia!")).toBe(false);
  });
});

describe("userSaysThatsAll", () => {
  it("família 'era isso mesmo' encerra", () => {
    for (const msg of [
      "Seria só com isso",
      "seria só isso",
      "Era só isso mesmo",
      "só isso mesmo",
      "Por enquanto era isso",
      "era isso",
      "Sim, era isso",
      "acho que é isso",
      "No momento é só isso",
      "não preciso de mais nada",
      "era isso, obrigada!",
    ]) {
      expect(userSaysThatsAll(msg), msg).toBe(true);
    }
  });

  it("pendência, pergunta ou correção não encerra", () => {
    for (const msg of [
      "seria só isso, mas não consegui acessar",
      "era isso, e sobre a prova?",
      "era isso, e sobre a prova",
      "não era isso",
      "não é só isso",
      "isso",
      "isso mesmo",
      "sim",
      "era só isso que eu queria confirmar com o atendente",
    ]) {
      expect(userSaysThatsAll(msg), msg).toBe(false);
    }
  });

  it("entra na varredura e no worker via studentWrappedUp", () => {
    expect(studentWrappedUp("Seria só com isso")).toBe(true);
    expect(studentWrappedUp("Isso mesmo, obrigada")).toBe(true);
    expect(studentWrappedUp("seria só isso, mas não consegui acessar")).toBe(
      false,
    );
  });

  it("inbox encerra na hora, sem esperar a despedida", () => {
    expect(
      shouldCloseAiAfterStudentMessage({ userMessage: "Seria só com isso" }),
    ).toEqual({ close: true, reason: "thats_all" });
  });
});

describe("userWantsSoftAiClose", () => {
  it("resposta ao check-in de 30 min encerra", () => {
    expect(userWantsSoftAiClose("Seria só com isso")).toBe(true);
    expect(userWantsSoftAiClose("era isso mesmo")).toBe(true);
    expect(userWantsSoftAiClose("já resolvi")).toBe(true);
  });

  it("resposta que reabre o assunto não encerra", () => {
    expect(userWantsSoftAiClose("não era isso")).toBe(false);
    expect(userWantsSoftAiClose("ainda preciso de ajuda")).toBe(false);
  });
});

describe("shouldCloseAfterAgentFarewell", () => {
  it("caso Davi: elogio + obrigado, com despedida do agente, encerra", () => {
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage: "Ficou bom, usarei esse exemplo como base. Obrigado",
        replyText:
          "Que bom que gostou, Davi! Qualquer coisa que precisar, tô aqui pra ajudar, tá? Boa sorte no seu projeto e nos estudos! 😊 Boa tarde!",
      }),
    ).toBe(true);
  });

  it("caso Davi: aluno retribui a despedida e o agente responde, encerra", () => {
    expect(
      shouldCloseAfterAgentFarewell({
        userMessage:
          "Desejo o mesmo, uma ótima tarde pra você também, boa quarta-feira!",
        replyText:
          "Obrigado, Davi! Aproveite bastante sua quarta-feira e conte comigo sempre que precisar. 😊 Boa tarde!",
      }),
    ).toBe(true);
  });

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
