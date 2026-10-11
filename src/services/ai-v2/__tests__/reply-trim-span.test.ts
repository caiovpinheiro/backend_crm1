import { describe, expect, it } from "vitest";

import { isMutilated, splitReplyUnits, trimUnsupportedSentences } from "../reply-trim";

const URL = "https://painel.exemplo.com/entrar";

describe("corte — só o trecho marcado, sem mutilar a resposta", () => {
  it("link sem ponto no fim separa a frase: a oração marcada sai e o link fica", () => {
    const reply = `Oi, Ana!\n\nPara o primeiro pedido, entre no painel: ${URL} Use seu e-mail cadastrado e a senha provisória Ana@123456.\n\nSe aparecer uma tela de segurança:\n1. Clique em Avançar.\n2. Escolha Telefone.`;
    expect(splitReplyUnits(reply).map((u) => u.text)).toContain(`Para o primeiro pedido, entre no painel: ${URL}`);
    const r = trimUnsupportedSentences(reply, ["Use seu e-mail cadastrado e a senha provisória Ana@123456"]);
    expect(r?.reply).toContain(URL);
    expect(r?.reply).not.toContain("senha provisória");
    expect(r?.reply.startsWith("Oi, Ana!")).toBe(true);
    expect(r?.reply).toContain("1. Clique em Avançar.");
  });

  it("oração marcada no meio de uma frase com link: só ela sai", () => {
    const reply = `Para trocar o produto, entre em ${URL} e confirme o pedido; o reembolso cai na sua conta em até dois dias úteis após a confirmação. Leve também o documento com foto na loja.`;
    const r = trimUnsupportedSentences(reply, ["o reembolso cai na sua conta em até dois dias úteis após a confirmação"]);
    expect(r?.reply).toBe(`Para trocar o produto, entre em ${URL} e confirme o pedido. Leve também o documento com foto na loja.`);
    expect(r?.removed[0]).toContain("→");
  });

  it("não sai mutilada: perder o link ou ficar começando por 'Se aparecer' cancela o corte", () => {
    const reply = `Para o primeiro pedido, entre no painel: ${URL} e use seu e-mail cadastrado.\n\nSe aparecer uma tela de segurança:\n1. Clique em Avançar.\n2. Escolha Telefone.`;
    expect(trimUnsupportedSentences(reply, [`entre no painel: ${URL} e use seu e-mail cadastrado`])).toBeNull();
    expect(isMutilated("Oi, Ana. Se aparecer uma tela, clique em Avançar.", "Se aparecer uma tela, clique em Avançar.")).toBe(true);
    expect(isMutilated("Faça assim:\n1. Abra.\n2. Feche.", "1. Abra.\n2. Feche.")).toBe(true);
    expect(isMutilated(`Entre em ${URL} e confirme.`, "Entre e confirme.")).toBe(true);
    expect(isMutilated(`Entre em ${URL} e confirme.`, "Entre e confirme.", [`entre em ${URL}`])).toBe(false);
    expect(isMutilated("Se quiser, faça assim.", "Se quiser, faça assim.")).toBe(false);
  });
});

describe("trecho cortado do começo da frase", () => {
  it("“Se X, me diga…” sem X vira “Me diga…”, sem vírgula órfã nem minúscula", async () => {
    const { trimUnsupportedSentences } = await import("../reply-trim");
    const reply = "Maria, entendo. Se o sistema do cliente está em manutenção, me diga qual atividade você precisa fazer agora para eu orientar a melhor alternativa.";
    const r = trimUnsupportedSentences(reply, ["Se o sistema do cliente está em manutenção"]);
    expect(r?.reply).toBe("Maria, entendo. Me diga qual atividade você precisa fazer agora para eu orientar a melhor alternativa.");
  });
});

describe("afirmação marcada que abrange duas frases", () => {
  it("as duas saem; a frase com “Depois,” não fica solta", async () => {
    const { trimUnsupportedSentences } = await import("../reply-trim");
    const reply = "Entendi. Para localizar a fatura de setembro, abra o sistema e toque em Pagamentos. Depois, selecione a fatura de setembro para pagar.\n\nComo o sistema está em manutenção, tente novamente no próximo dia útil, mantendo as mesmas condições combinadas.";
    const r = trimUnsupportedSentences(reply, ["Para localizar a fatura de setembro, abra o sistema e toque em Pagamentos. Depois, selecione a fatura de setembro para pagar."]);
    expect(r?.reply).not.toContain("Depois");
    expect(r?.reply).not.toContain("selecione a fatura");
    expect(r?.reply).toContain("Como o sistema está em manutenção");
  });

  it("frase seguinte a uma cortada que começa com conector de sequência perde o conector", async () => {
    const { trimUnsupportedSentences } = await import("../reply-trim");
    const reply = "Abra o sistema e vá na área de cadastro do seu perfil pessoal. Em seguida, confira se o seu e-mail principal está correto e atualizado no cadastro.";
    const r = trimUnsupportedSentences(reply, ["Abra o sistema e vá na área de cadastro do seu perfil pessoal."]);
    expect(r?.reply).toBe("Confira se o seu e-mail principal está correto e atualizado no cadastro.");
  });
});
