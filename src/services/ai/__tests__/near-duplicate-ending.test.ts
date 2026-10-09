import { describe, expect, it } from "vitest";

import { isNearDuplicateBotText, isNearDuplicateBotTextIgnoring } from "@/services/ai/human-queue-policy";

/**
 * O fecho configurado se repete de propósito em várias respostas. Longo, ele
 * dominava a comparação da trava anti-repetição: duas respostas de conteúdo
 * diferente passavam de 70% de palavras em comum (este par: 72%) e a segunda
 * era barrada.
 */
const ENDING =
  "Posso te ajudar em mais alguma coisa? 😊\n\n_Se não tiver mais nenhuma dúvida, tudo bem! Caso eu não receba uma resposta nos próximos 30 minutos, vou encerrar este atendimento por aqui._";

const first = `Tudo bem, Ana. O boleto fica disponível na sua Área do Cliente, em *Pagar Fatura*.\n\n${ENDING}`;
const second = `Ana, para gerar o pagamento, acesse a sua *Área do Cliente*, toque em *Pagar Fatura*, escolha o título desejado e selecione *boleto* ou *cartão*.\n\n${ENDING}`;

describe("trava anti-repetição sem contar o fecho", () => {
  it("reproduz o defeito: com o fecho, respostas diferentes contam como repetição", () => {
    expect(isNearDuplicateBotText(second, first)).toBe(true);
  });

  it("ignorando o fecho, conteúdo diferente passa", () => {
    expect(isNearDuplicateBotTextIgnoring(second, first, [ENDING])).toBe(false);
  });

  it("o mesmo conteúdo continua barrado, com ou sem fecho", () => {
    expect(isNearDuplicateBotTextIgnoring(second, second, [ENDING])).toBe(true);
    const noEnding = second.replace(ENDING, "").trim();
    expect(isNearDuplicateBotTextIgnoring(second, noEnding, [ENDING])).toBe(true);
  });

  it("o fecho sozinho repetido continua repetição; contra uma resposta com conteúdo, não", () => {
    expect(isNearDuplicateBotTextIgnoring(ENDING, ENDING, [ENDING])).toBe(true);
    expect(isNearDuplicateBotTextIgnoring(second, ENDING, [ENDING])).toBe(false);
  });

  it("sem trechos a ignorar, comportamento de antes", () => {
    expect(isNearDuplicateBotTextIgnoring(second, first, [])).toBe(isNearDuplicateBotText(second, first));
    expect(isNearDuplicateBotTextIgnoring(second, first, ["ok"])).toBe(isNearDuplicateBotText(second, first));
  });
});
