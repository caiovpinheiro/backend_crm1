import { describe, expect, it } from "vitest";

import { standaloneClause, trimUnsupportedSentences } from "../reply-trim";
import { handoffExplanation, withoutTransferClause } from "../no-source";
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
    expect(standaloneClause("O boleto vence em 3 dias úteis")).toBe("O boleto vence em 3 dias úteis");
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

    const causal = "Separei as informações do seu pedido. Como o boleto vence em 3 dias úteis, pague até sexta-feira pelo aplicativo da loja. A segunda via fica em Minha conta, na parte de pedidos.";
    const c = trimUnsupportedSentences(causal, ["pague até sexta-feira pelo aplicativo da loja"]);
    expect(c?.reply).toBe("Separei as informações do seu pedido. O boleto vence em 3 dias úteis. A segunda via fica em Minha conta, na parte de pedidos.");
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
    expect(claimFoundInSources("Escolha *Boleto*.", sources)).toBe(false);
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

