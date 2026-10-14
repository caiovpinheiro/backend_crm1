import { describe, expect, it } from "vitest";

import { standaloneClause, trimUnsupportedSentences } from "../reply-trim";
import { conditionalHandoff, handoffExplanation, withoutTransferClause } from "../no-source";
import { claimFoundInSources, sameClaim } from "../claim-check";
import { repairMessageModelId } from "../action-policy";

describe("o que sobra de uma frase cortada fica de pé", () => {
  it("oração de causa perde o conector; finalidade, condição e tempo sozinhas saem; com vírgula dentro, fica", () => {
    expect(standaloneClause("Como você quer cancelar o pedido")).toBe("Você quer cancelar o pedido");
    expect(standaloneClause("Já que o prazo terminou")).toBe("O prazo terminou");
    expect(standaloneClause("Para o primeiro acesso")).toBe("");
    expect(standaloneClause("Se o código não chegar")).toBe("");
    expect(standaloneClause("Ana, para informar o valor com segurança")).toBe("");
    expect(standaloneClause("Ana, como o prazo terminou")).toBe("Ana, o prazo terminou");
    expect(standaloneClause("Para acessar sua conta, você precisa do e-mail")).toBe("Para acessar sua conta, você precisa do e-mail");
    expect(standaloneClause("A fatura vence em 3 dias úteis")).toBe("A fatura vence em 3 dias úteis");
  });

  it("aviso de transferência: não deixa \"Como X.\" nem \"X;.\"", () => {
    expect(handoffExplanation("Entendo, ficar apertado financeiramente pesa mesmo. Como você quer cancelar o pedido, vou te passar para o time responsável."))
      .toBe("Entendo, ficar apertado financeiramente pesa mesmo. Você quer cancelar o pedido.");
    expect(withoutTransferClause("Não tenho informação segura sobre as regras da promoção; vou te passar para alguém da equipe."))
      .toBe("Não tenho informação segura sobre as regras da promoção.");
    expect(withoutTransferClause("Para concluir o cadastro, vou chamar alguém da equipe.")).toBe("");
    expect(withoutTransferClause("Ana, para informar o valor com segurança, vou te passar para o time.")).toBe("");
    // "chamar o time de X" também é aviso: a explicação fica, o aviso vira a mensagem configurada.
    expect(handoffExplanation("Como o e-mail menciona uma data diferente do calendário e a avaliação não apareceu para você, vou chamar o time de Atendimento para verificar o caso."))
      .toBe("O e-mail menciona uma data diferente do calendário e a avaliação não apareceu para você.");
    expect(withoutTransferClause("Para acessar sua conta, você precisa do e-mail cadastrado, então vou te passar para a equipe."))
      .toBe("Para acessar sua conta, você precisa do e-mail cadastrado.");
  });

  it("trecho sem fonte no fim da frase: a oração que abria a frase não fica sozinha", () => {
    const reply = "Entendo sua dúvida sobre o acesso. Para o primeiro acesso, a senha provisória é enviada ao e-mail cadastrado em até 24 horas. Se o e-mail não chegar, confira a caixa de spam e o endereço usado na compra antes de tentar de novo.";
    const r = trimUnsupportedSentences(reply, ["a senha provisória é enviada ao e-mail cadastrado em até 24 horas"]);
    expect(r?.reply).toBe("Entendo sua dúvida sobre o acesso. Se o e-mail não chegar, confira a caixa de spam e o endereço usado na compra antes de tentar de novo.");

    const causal = "Separei as informações do seu pedido. Como a fatura vence em 3 dias úteis, pague até sexta-feira pelo aplicativo da loja. A segunda via fica em Minha conta, na parte de pedidos.";
    const c = trimUnsupportedSentences(causal, ["pague até sexta-feira pelo aplicativo da loja"]);
    expect(c?.reply).toBe("Separei as informações do seu pedido. A fatura vence em 3 dias úteis. A segunda via fica em Minha conta, na parte de pedidos.");
  });
});

describe("checagem por modelo — nome de tela ou botão que está na fonte", () => {
  const sources = ["Em Minha conta, clique em Pagar Fatura e escolha o pedido.", "A taxa de cancelamento é de R$ 20."];

  it("duas palavras juntas na fonte, na ordem: sustentado", () => {
    expect(claimFoundInSources("Toque em *Pagar Fatura*.", sources)).toBe(true);
  });

  it("botão que não existe, ordem trocada ou negação: continua marcado", () => {
    expect(claimFoundInSources("Toque em *Emitir Carnê*.", sources)).toBe(false);
    expect(claimFoundInSources("Toque em *Fatura Pagar*.", sources)).toBe(false);
    expect(claimFoundInSources("Não há taxa de cancelamento.", sources)).toBe(false);
  });
});

describe("segunda leitura da checagem — mesma afirmação recortada de outro jeito", () => {
  it("reconhece o mesmo trecho com recorte diferente; afirmações diferentes não casam", () => {
    expect(sameClaim("Se aparecer uma solicitação de segurança, clique em *Avançar*.", "clique em Avançar")).toBe(true);
    expect(sameClaim("A garantia estendida cobre qualquer defeito de fábrica", "garantia estendida cobre defeitos")).toBe(true);
    expect(sameClaim("A garantia estendida cobre qualquer defeito de fábrica", "O reembolso cai em 5 dias úteis")).toBe(false);
  });
});

describe("checagem por modelo — afirmação em várias frases e passo de uma palavra", () => {
  const sources = [
    "1. Toque em Primeiro acesso\n2. Quando pedir segurança, clique em Avançar\n3. Escolha a opção Telefone\nPronto! Sua conta estará configurada para acesso.",
    "Acesso pelo celular\nPara facilitar, recomendamos utilizar o aplicativo Exemplo.",
  ];

  it("cada frase vem de um trecho diferente: sustentada quando todas estão nas fontes", () => {
    expect(claimFoundInSources("Depois disso, sua conta estará configurada para acesso. Pelo celular, você também pode usar o aplicativo Exemplo.", sources)).toBe(true);
    expect(claimFoundInSources("Depois disso, sua conta estará configurada para acesso. O acesso expira em 30 dias corridos.", sources)).toBe(false);
  });

  it("passo de uma palavra: vale com o mesmo verbo na mesma frase da fonte", () => {
    expect(claimFoundInSources("Escolha *Telefone*.", sources)).toBe(true);
    expect(claimFoundInSources("Toque em *Telefone*.", sources)).toBe(false);
    expect(claimFoundInSources("Escolha *Carnê*.", sources)).toBe(false);
  });
});

describe("id de mensagem pronta copiado com erro", () => {
  const allowed = ["cmaaa11bbb0055xx01po81pgsw", "cmaaa11ccc0057xx01zz99qqrt"];

  it("uma letra a mais, a menos ou trocada vira o id liberado", () => {
    expect(repairMessageModelId("cmaaa11gbbb0055xx01po81pgsw", allowed)).toBe("cmaaa11bbb0055xx01po81pgsw");
    expect(repairMessageModelId("cmaaa11bb0055xx01po81pgsw", allowed)).toBe("cmaaa11bbb0055xx01po81pgsw");
    expect(repairMessageModelId("cmaaa11bbb0055xx01po81pgsx", allowed)).toBe("cmaaa11bbb0055xx01po81pgsw");
  });

  it("id liberado fica; id distante ou perto de dois liberados não é trocado", () => {
    expect(repairMessageModelId("cmaaa11ccc0057xx01zz99qqrt", allowed)).toBe("cmaaa11ccc0057xx01zz99qqrt");
    expect(repairMessageModelId("cmzzz99yyy0000zz00aa00aaaa", allowed)).toBe("cmzzz99yyy0000zz00aa00aaaa");
    expect(repairMessageModelId("abc1", ["abc2", "abc3"])).toBe("abc1");
  });
});


describe("aviso de transferência: explicação que sobra e condição com “acionar o time”", () => {
  it("causa que só apontava para o que foi cortado (“dessa informação”) não vira frase solta", () => {
    expect(standaloneClause("Como você precisa dessa informação para seguir")).toBe("");
    expect(standaloneClause("Como isso depende do cadastro")).toBe("");
    // Causa com conteúdo próprio continua.
    expect(standaloneClause("Como você quer cancelar o pedido")).toBe("Você quer cancelar o pedido");
    // Sem a frase solta, sobra só cortesia: sai apenas o aviso configurado.
    expect(handoffExplanation("Bom dia! Imagino como isso atrapalha. Como você precisa dessa informação para seguir, vou chamar alguém da equipe para orientar.")).toBe("");
    // Com explicação de verdade antes, ela fica e a causa solta sai.
    const kept = handoffExplanation("O sistema de pagamentos está em manutenção desde ontem e não aceita cobranças novas no momento. Como você precisa dessa informação para seguir, vou chamar alguém da equipe.");
    expect(kept).toContain("está em manutenção desde ontem");
    expect(kept).not.toContain("dessa informação");
  });

  it("transferência condicionada com “acionar o time” ou “passar para a equipe” espera o cliente; sem condição, não", () => {
    const reply = "Para pagar, tente pelo site: 1. Entre na sua conta. 2. Toque em Pagamentos.\n\nSe o site também apresentar erro, será necessário acionar o time de Atendimento para analisar o caso.";
    expect(conditionalHandoff(reply)).toBe(true);
    expect(conditionalHandoff("Caso o código não chegue, vou te passar para a equipe.")).toBe(true);
    expect(conditionalHandoff("Vou acionar o time para analisar o seu caso.")).toBe(false);
    expect(conditionalHandoff("Se precisar, é só me chamar.")).toBe(false);
  });
});

describe("frase sem oração principal depois de um corte", () => {
  it("causa + finalidade, finalidade + causa, causa + \"mas\": a causa vira a principal; sem causa, sai", () => {
    expect(standaloneClause("Como o pedido aparece como entregue em 07/10, mas você não recebeu a encomenda"))
      .toBe("O pedido aparece como entregue em 07/10, mas você não recebeu a encomenda");
    expect(standaloneClause("Para a taxa de entrega, como a fatura não foi emitida")).toBe("A fatura não foi emitida");
    expect(standaloneClause("Como você só consegue pagar no dia 30, para verificar uma condição específica")).toBe("Você só consegue pagar no dia 30");
    expect(standaloneClause("Para concluir a troca, se o código não chegar")).toBe("");
    expect(standaloneClause("No Portal do Cliente")).toBe("");
    // Com oração principal, nada muda.
    expect(standaloneClause("Se precisar, me chame por aqui")).toBe("Se precisar, me chame por aqui");
    expect(standaloneClause("No aplicativo, toque em Minha conta")).toBe("No aplicativo, toque em Minha conta");
  });

  it("aviso de transferência no fim de \"Como X, mas Y\": fica a explicação de pé", () => {
    expect(withoutTransferClause("Como o pedido aparece como entregue em 07/10, mas você não recebeu a encomenda, vou te passar para o time de Atendimento."))
      .toBe("O pedido aparece como entregue em 07/10, mas você não recebeu a encomenda.");
    expect(withoutTransferClause("Para a taxa de entrega, como a fatura não foi emitida, vou te passar para a equipe."))
      .toBe("A fatura não foi emitida.");
  });

  it("artigo ou preposição colado ao trecho cortado: a frase sai inteira", () => {
    const reply = "Entendi a dúvida sobre o documento. Você precisa do recibo de quitação assinado pelo setor, não da declaração simples. A equipe consegue emitir o documento certo para você.";
    expect(trimUnsupportedSentences(reply, ["recibo de quitação assinado pelo setor"])?.reply)
      .toBe("Entendi a dúvida sobre o documento. A equipe consegue emitir o documento certo para você.");
  });

  it("condição que pertencia ao aviso de transferência sai junto (vírgula ou travessão)", () => {
    expect(withoutTransferClause("Poxa, Ana, entendo a frustração — se o pedido continua em análise mesmo após a reclamação, vou te passar para o time."))
      .toBe("Poxa, Ana, entendo a frustração.");
    expect(withoutTransferClause("O pedido consta como entregue, para conferir com a transportadora vou chamar alguém da equipe."))
      .toBe("O pedido consta como entregue.");
    // Sem oração principal antes, nada sobra.
    expect(withoutTransferClause("Para conferir com a transportadora, vou chamar alguém da equipe.")).toBe("");
  });

  it("trecho sem fonte no meio, no começo ou no fim: o que sobra não fica pela metade", () => {
    const meio = "Entendo a situação. Como você só consegue pagar no dia 30, a condição de desconto pode não ser mantida, para verificar uma condição específica. A equipe consegue olhar outras formas de pagamento com você.";
    expect(trimUnsupportedSentences(meio, ["a condição de desconto pode não ser mantida"])?.reply)
      .toBe("Entendo a situação. Você só consegue pagar no dia 30. A equipe consegue olhar outras formas de pagamento com você.");

    const comeco = "Entendo a preocupação com o valor da fatura deste mês. O valor pode sofrer reajuste conforme as regras da loja, e não consigo congelá-lo por aqui. A equipe consegue revisar as condições do seu plano com você.";
    expect(trimUnsupportedSentences(comeco, ["O valor pode sofrer reajuste conforme as regras da loja"])?.reply)
      .toBe("Entendo a preocupação com o valor da fatura deste mês. A equipe consegue revisar as condições do seu plano com você.");

    const fim = "Entendo a preocupação com as duas faturas em aberto. No Portal do Cliente, você consegue consultar e pagar as faturas pela opção Pagar Fatura. A equipe consegue ver com você uma forma de regularizar as duas.";
    expect(trimUnsupportedSentences(fim, ["você consegue consultar e pagar as faturas pela opção Pagar Fatura"])?.reply)
      .toBe("Entendo a preocupação com as duas faturas em aberto. A equipe consegue ver com você uma forma de regularizar as duas.");
  });
});
