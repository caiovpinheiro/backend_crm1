import { describe, expect, it } from "vitest";

import { claimValueFromClient, notAFactClaim } from "../claim-check";
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

describe("checagem — condição sozinha não é afirmação", () => {
  it("“se X” sem consequência e sem número é hipótese; com consequência ou número continua conferida", () => {
    expect(notAFactClaim("Se o sistema do cliente está em manutenção")).toBe(true);
    expect(notAFactClaim("Caso o código não chegue")).toBe(true);
    expect(notAFactClaim("Se você pagar até o dia 10, tem desconto")).toBe(false);
    expect(notAFactClaim("Se pagar até 10/11 o desconto é mantido")).toBe(false);
  });
});

describe("acolhimento e paráfrase do cliente não são fato a conferir (rodada 2)", () => {
  it("empatia sem número passa; afirmação de oferta não", () => {
    expect(notAFactClaim("Sinto muito pela demora, a frustração faz sentido")).toBe(true);
    expect(notAFactClaim("Sinto muito, o curso é reconhecido pelo MEC com nota 5")).toBe(false);
  });
});

describe("rodada 4 (27/11): pedido repetido, estado do atendimento e valor escrito pelo cliente", () => {
  it("\"você quer…\" e \"anotei / já tá com a equipe\" não são fato a conferir; prazo continua sendo", () => {
    expect(notAFactClaim("Entendi, você quer o vencimento no dia 20.")).toBe(true);
    expect(notAFactClaim("Anotei seu pedido e alguém da equipe te responde por aqui")).toBe(true);
    expect(notAFactClaim("Seu pedido de correção do nome já tá com a equipe; te respondo por aqui.")).toBe(true);
    expect(notAFactClaim("Anotei e a equipe te responde em até 2 dias úteis")).toBe(false);
  });

  it("valor que o cliente afirmou vale; valor que ele perguntou, não", () => {
    const card = ["[SIMULADO - pós; o cartão do curso mostra taxa de matrícula de R$ 99] || Mensagem do cliente: na pós tem prova?", "quanto é a taxa?"];
    expect(claimValueFromClient("A taxa de matrícula do seu curso é R$ 99", card)).toBe(true);
    const proposal = ["[SIMULADO - proposta: Taxa de matrícula: R$ 99. Mensalidades em 15 parcelas.] || Mensagem do cliente: a taxa dá pra parcelar?"];
    expect(claimValueFromClient("A taxa de matrícula é R$ 99, como está na proposta", proposal)).toBe(true);
    expect(claimValueFromClient("A taxa é R$ 30", ["a taxa é R$ 30, né?"])).toBe(false);
    expect(claimValueFromClient("A taxa é R$ 30 em 3 parcelas", ["a taxa é R$ 30"])).toBe(false);
  });
});
