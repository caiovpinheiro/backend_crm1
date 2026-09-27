import { describe, expect, it } from "vitest";

import { notAFactClaim } from "../claim-check";
import { unsupportedFacts } from "../ground-reply";

describe("checagem — marcações que não são afirmação de fato", () => {
  it("admitir que não sabe, avisar transferência e repetir o cliente não barram a resposta", () => {
    expect(notAFactClaim("Eu não consigo confirmar se a aula será no polo de São Miguel")).toBe(true);
    expect(notAFactClaim("Sobre aulas ao vivo, não tenho essa informação para confirmar")).toBe(true);
    expect(notAFactClaim("O valor da avaliação não está informado para mim.")).toBe(true);
    expect(notAFactClaim("vou encaminhar seu atendimento ao setor responsável por retenção para dar continuidade à solicitação")).toBe(true);
    expect(notAFactClaim("Você enviou um comprovante de *40 horas* ontem e o sistema recusou o de *60 horas*")).toBe(true);
  });

  it("afirmação de fato continua sendo conferida", () => {
    expect(notAFactClaim("Sim, você pode acompanhar as aulas pelo notebook.")).toBe(false);
    expect(notAFactClaim("boleto vence no dia seguinte à solicitação")).toBe(false);
    expect(notAFactClaim("A instalação é gratuita")).toBe(false);
  });

  it("prazo escrito abreviado pelo cliente vale por extenso", () => {
    expect(unsupportedFacts("Para completar as 120 horas, envie outro comprovante.", ["preciso completar 120h"])).toEqual([]);
    expect(unsupportedFacts("O limite é de 40 horas.", ["não de 40h"])).toEqual([]);
    expect(unsupportedFacts("O limite é de 50 horas.", ["não de 40h"])).toEqual(["50 horas"]);
  });

  it("rodada 2: motivo de transferir, fala do cliente no meio da frase, pedido ao cliente, número do cliente", () => {
    expect(notAFactClaim("trancamento precisa ser tratado por uma pessoa da equipe")).toBe(true);
    expect(notAFactClaim("certificado que você enviou informa *1.846 horas*, e não 40 horas")).toBe(true);
    expect(notAFactClaim("Você já enviou um comprovante de 40 horas e o sistema não aceitou o de 60 horas")).toBe(true);
    expect(notAFactClaim("Para eu identificar por que o sistema recusou, envie o texto exato da mensagem de erro.")).toBe(true);
    expect(notAFactClaim("A reprovação acontece quando a média fica abaixo de 6.")).toBe(false);
    expect(unsupportedFacts("Selecione a opção de 14 horas.", ["o curso"], ["enviei nessa de 10 a 14 e foi"])).toEqual([]);
    expect(unsupportedFacts("Selecione a opção de 18 horas.", ["o curso"], ["enviei nessa de 10 a 14 e foi"])).toEqual(["18 horas"]);
  });
});
