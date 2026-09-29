import { describe, expect, it } from "vitest";

import { notAFactClaim } from "../claim-check";
import { unsupportedFacts } from "../ground-reply";

describe("checagem — marcações que não são afirmação de fato", () => {
  it("admitir que não sabe, avisar transferência e repetir o cliente não barram a resposta", () => {
    expect(notAFactClaim("Eu não consigo confirmar se a entrega será na loja do centro")).toBe(true);
    expect(notAFactClaim("Sobre atendimento presencial, não tenho essa informação para confirmar")).toBe(true);
    expect(notAFactClaim("O valor da avaliação não está informado para mim.")).toBe(true);
    expect(notAFactClaim("vou encaminhar seu atendimento ao setor responsável para dar continuidade à solicitação")).toBe(true);
    expect(notAFactClaim("Você enviou um arquivo de *40 páginas* ontem e o sistema recusou o de *60 páginas*")).toBe(true);
  });

  it("afirmação de fato continua sendo conferida", () => {
    expect(notAFactClaim("Sim, você pode usar o aplicativo pelo notebook.")).toBe(false);
    expect(notAFactClaim("a fatura vence no dia seguinte ao pedido")).toBe(false);
    expect(notAFactClaim("A instalação é gratuita")).toBe(false);
  });

  it("prazo escrito abreviado pelo cliente vale por extenso", () => {
    expect(unsupportedFacts("Para completar as 120 horas, envie outro comprovante.", ["preciso completar 120h"])).toEqual([]);
    expect(unsupportedFacts("O limite é de 40 horas.", ["não de 40h"])).toEqual([]);
    expect(unsupportedFacts("O limite é de 50 horas.", ["não de 40h"])).toEqual(["50 horas"]);
  });

  it("rodada 2: motivo de transferir, fala do cliente no meio da frase, pedido ao cliente, número do cliente", () => {
    expect(notAFactClaim("o cancelamento precisa ser tratado por uma pessoa da equipe")).toBe(true);
    expect(notAFactClaim("o arquivo que você enviou informa *1.846 páginas*, e não 40")).toBe(true);
    expect(notAFactClaim("Você já enviou um arquivo de 40 páginas e o sistema não aceitou o de 60")).toBe(true);
    expect(notAFactClaim("Para eu identificar por que o sistema recusou, envie o texto exato da mensagem de erro.")).toBe(true);
    expect(notAFactClaim("A garantia vale quando o produto tem menos de 6 meses.")).toBe(false);
    expect(unsupportedFacts("Selecione a opção de 14 horas.", ["o pedido"], ["enviei nessa de 10 a 14 e foi"])).toEqual([]);
    expect(unsupportedFacts("Selecione a opção de 18 horas.", ["o pedido"], ["enviei nessa de 10 a 14 e foi"])).toEqual(["18 horas"]);
  });
});
