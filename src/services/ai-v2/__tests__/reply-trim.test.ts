import { describe, expect, it } from "vitest";

import { onlyKeptSentences, trimUnsupportedSentences } from "../reply-trim";

describe("corte de frase sem fonte", () => {
  it("tira só a frase marcada e mantém o resto", () => {
    const reply = "A troca é feita na loja com a nota fiscal. O reembolso cai em 5 dias úteis na sua conta. Leve também o documento com foto.";
    const r = trimUnsupportedSentences(reply, ["5 dias úteis"]);
    expect(r?.reply).toBe("A troca é feita na loja com a nota fiscal. Leve também o documento com foto.");
    expect(r?.removed).toEqual(["O reembolso cai em 5 dias úteis na sua conta."]);
  });

  it("acha a frase pela paráfrase do checador e limpa o conector que ficou órfão", () => {
    const reply = "Você pode trocar o produto na loja.\n\nA garantia estendida cobre qualquer defeito de fábrica sem custo. Além disso, a nota fiscal precisa estar no nome de quem comprou.";
    const r = trimUnsupportedSentences(reply, ["garantia estendida cobre defeito de fábrica"]);
    expect(r?.reply).toBe("Você pode trocar o produto na loja.\n\nA nota fiscal precisa estar no nome de quem comprou.");
  });

  it("passo de lista sem fonte sai inteiro e os outros são renumerados", () => {
    const steps = "Para trocar o produto:\n1. Vá até a loja com a nota fiscal e o produto na embalagem.\n2. Peça o reembolso em dinheiro na hora.\n3. Guarde o comprovante que o atendente entregar.";
    const r = trimUnsupportedSentences(steps, ["Peça o reembolso em dinheiro na hora"]);
    expect(r?.reply).toBe("Para trocar o produto:\n1. Vá até a loja com a nota fiscal e o produto na embalagem.\n2. Guarde o comprovante que o atendente entregar.");
    const keycaps = "Para entrar no aplicativo:\n1️⃣ Acesse o aplicativo da loja com o seu e-mail.\n2️⃣ Informe seus dados de acesso.\n3️⃣ Toque em Avançar e confirme o código que chegar por SMS.\n4️⃣ Crie uma senha nova com oito caracteres.";
    expect(trimUnsupportedSentences(keycaps, ["Informe seus dados de acesso."])?.reply)
      .toBe("Para entrar no aplicativo:\n1️⃣ Acesse o aplicativo da loja com o seu e-mail.\n2️⃣ Toque em Avançar e confirme o código que chegar por SMS.\n3️⃣ Crie uma senha nova com oito caracteres.");
  });

  it("não corta quando a lista ficaria com um passo só, nem frase que não localiza", () => {
    const two = "Para trocar o produto na loja física:\n1. Vá até a loja com a nota fiscal e o produto.\n2. Peça o reembolso em dinheiro na hora.";
    expect(trimUnsupportedSentences(two, ["Peça o reembolso em dinheiro na hora"])).toBeNull();
    expect(trimUnsupportedSentences("A troca é feita na loja com a nota fiscal. Leve o documento com foto.", ["prazo de 30 dias"])).toBeNull();
  });

  it("não vale quando o que sobra não responde mais", () => {
    expect(trimUnsupportedSentences("A instalação é gratuita para todos os planos.", ["A instalação é gratuita"])).toBeNull();
    expect(trimUnsupportedSentences("Pode ficar tranquilo. A instalação é gratuita para todos os planos. Qualquer dúvida, é só chamar.", ["A instalação é gratuita para todos os planos"])).toBeNull();
  });

  it("reescrita que só tirou frases (mesmo renumerando) não tem nada novo a conferir", () => {
    const original = "Para trocar:\n1. Vá até a loja com a nota fiscal.\n2. Peça o reembolso em dinheiro na hora.\n3. Guarde o comprovante.";
    const rewritten = "Para trocar:\n1. Vá até a loja com a nota fiscal.\n2. Guarde o comprovante.";
    expect(onlyKeptSentences(rewritten, original, ["Peça o reembolso em dinheiro na hora"])).toBe(true);
    expect(onlyKeptSentences("Para trocar, vá à loja. O reembolso é feito por transferência.", original, ["Peça o reembolso em dinheiro na hora"])).toBe(false);
    expect(onlyKeptSentences("A instalação é gratuita, sim.", "Pode ficar tranquilo, a instalação é gratuita para todos os planos.", ["a instalação é gratuita para todos os planos"])).toBe(false);
  });
});
