import { describe, expect, it } from "vitest";

import { isMutilated, prescribedReplyMatching, splitReplyUnits, trimUnsupportedSentences } from "../reply-trim";

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

  it("trecho marcado termina em negrito: o fechamento sai junto, sem '*;' solto", () => {
    const reply = "O *Painel* está em manutenção e pode ficar indisponível. O lote de outubro começou em *1º de outubro*; quando o painel voltar, confira de novo a sua lista de pedidos. Ele chega a abrir para você?";
    const r = trimUnsupportedSentences(reply, ["O lote de outubro começou em *1º de outubro*"]);
    expect(r?.reply).toBe("O *Painel* está em manutenção e pode ficar indisponível. Quando o painel voltar, confira de novo a sua lista de pedidos. Ele chega a abrir para você?");
    const quoted = trimUnsupportedSentences("Abra o painel e confira os pedidos da semana com calma. O botão se chama “Pedidos antigos do mês” e fica no topo da tela.", ["O botão se chama Pedidos antigos do mês"]);
    expect(quoted?.reply).not.toMatch(/[“”]/);
  });

  it("frase seguinte a uma cortada que começa com conector de sequência perde o conector", async () => {
    const { trimUnsupportedSentences } = await import("../reply-trim");
    const reply = "Abra o sistema e vá na área de cadastro do seu perfil pessoal. Em seguida, confira se o seu e-mail principal está correto e atualizado no cadastro.";
    const r = trimUnsupportedSentences(reply, ["Abra o sistema e vá na área de cadastro do seu perfil pessoal."]);
    expect(r?.reply).toBe("Confira se o seu e-mail principal está correto e atualizado no cadastro.");
  });
});

describe("corte que tira a parte que respondia a pergunta", () => {
  it("o que sobra não fala de nada do que o cliente perguntou: o corte não vale", async () => {
    const { trimDroppedTheAnswer } = await import("../reply-trim");
    const question = "O conteúdo da avaliação vai ser em cima das aulas que vi na plataforma de vídeos?";
    const original = "A avaliação final compõe a nota junto com as atividades. Para saber os conteúdos cobrados, acompanhe as aulas da plataforma de vídeos da sua turma.";
    expect(trimDroppedTheAnswer(question, original, "A avaliação final compõe a nota junto com as atividades.")).toBe(false);
    const q2 = "Os conteúdos vão ser em cima das aulas que vi na plataforma de vídeos?";
    expect(trimDroppedTheAnswer(q2, original, "A avaliação final compõe a nota junto com as atividades.")).toBe(true);
    // O que sobrou ainda fala do que foi perguntado: o corte vale.
    expect(trimDroppedTheAnswer(q2, original, "Os conteúdos seguem as aulas da turma.")).toBe(false);
    // Pergunta curta, sem palavras de conteúdo suficientes: não decide.
    expect(trimDroppedTheAnswer("E aí?", original, "Ok.")).toBe(false);
  });
});

describe("trecho cortado entre o vocativo e o “mas”", () => {
  it("não sobra vírgula dupla nem “mas” sem o que ele opunha", async () => {
    const { trimUnsupportedSentences } = await import("../reply-trim");
    const reply = "Ana, um projeto de leitura em grupo pode contar como atividade de extensão cultural, mas o enquadramento precisa ser confirmado conforme as regras da sua turma. Fale com o responsável para validar.";
    const r = trimUnsupportedSentences(reply, ["um projeto de leitura em grupo pode contar como atividade de extensão cultural"]);
    expect(r?.reply).toBe("Ana, o enquadramento precisa ser confirmado conforme as regras da sua turma. Fale com o responsável para validar.");
  });
});

describe("frase literal da configuração quando a reescrita apaga a resposta", () => {
  const rules = [
    'A resposta é só: "Vou te enviar o formulário. Preencha para eu seguir com o seu cadastro."',
    'A resposta é exatamente: "Cadastro recebido. Vou seguir com o seu perfil."',
  ];
  const wiped = "Cadastro recebido e preenchido corretamente. Vou seguir com a análise para encontrar oportunidades compatíveis com o seu perfil.";
  const formSent = "Vou te enviar o formulário. Preencha para eu seguir com o seu cadastro.";

  it("devolve a frase que a resposta tentou dizer, e não a que já saiu", () => {
    expect(prescribedReplyMatching(rules, wiped, formSent)).toBe("Cadastro recebido. Vou seguir com o seu perfil.");
  });

  it("duas frases que cabem no que foi apagado: não escolhe", () => {
    const both = [
      'A resposta é exatamente: "Cadastro recebido. Vou seguir com o seu perfil."',
      'A resposta é exatamente: "Cadastro recebido. Vou seguir com o perfil."',
    ];
    expect(prescribedReplyMatching(both, wiped, formSent)).toBeNull();
  });

  it("nada parecido na configuração: não inventa frase", () => {
    expect(prescribedReplyMatching(['Não prometa vaga.'], wiped, formSent)).toBeNull();
  });
});
