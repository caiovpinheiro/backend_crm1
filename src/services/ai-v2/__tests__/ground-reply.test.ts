import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn() }));
vi.mock("../tools", () => ({ searchV2Knowledge: vi.fn() }));

describe("unsupportedQuotedTerms", () => {
  it("aponta nome entre aspas que não está em nenhuma fonte", async () => {
    const { unsupportedQuotedTerms } = await import("../ground-reply");
    const sources = ["1. Acesse a Área do Cliente\n2. Clique em Falar com Tutor", "cliente: como falo com o tutor?"];
    expect(unsupportedQuotedTerms('Vá em "Fale Conosco" ou "Atendimento".', sources)).toEqual(["Fale Conosco", "Atendimento"]);
    expect(unsupportedQuotedTerms("Clique em “Falar com Tutor” na “área do cliente”.", sources)).toEqual([]);
    expect(unsupportedQuotedTerms('Sem aspas e "123" não conta.', sources)).toEqual([]);
  });

  it("aceita o mesmo nome escrito de outro jeito, na mesma linha da fonte", async () => {
    const { unsupportedQuotedTerms } = await import("../ground-reply");
    const sources = ["3. Na tela de entrada, clique em Esqueci minha senha\n4. Informe o e-mail"];
    expect(unsupportedQuotedTerms('Clique em "Esqueci a senha".', sources)).toEqual([]);
    // Palavras em linhas diferentes não formam um nome.
    expect(unsupportedQuotedTerms('Clique em "Informe senha".', sources)).toEqual(["Informe senha"]);
  });
});

describe("unsupportedHedges", () => {
  it("palpite sem fonte é apontado; quando a fonte usa a palavra, passa", async () => {
    const { unsupportedHedges } = await import("../ground-reply");
    expect(unsupportedHedges('Geralmente é pela opção "Solicitações".', ["1. Acesse a área do cliente"])).toEqual(["geralmente"]);
    expect(unsupportedHedges("Normalmente sai em 2 dias.", ["O documento normalmente sai em 2 dias úteis."])).toEqual([]);
    // Sinônimo do que a fonte já diz ("normalmente" → "costuma") é paráfrase.
    expect(unsupportedHedges("O desconto costuma aparecer no corpo da fatura.", ["Os descontos normalmente aparecem no corpo da fatura."])).toEqual([]);
  });
});

describe("unsupportedFigures e isNearDuplicateReply", () => {
  it("aponta percentual e valor que não estão nas fontes", async () => {
    const { unsupportedFigures } = await import("../ground-reply");
    const src = ["O reajuste é de 8% a 12% ao ano. Taxa de R$ 1.290,00."];
    expect(unsupportedFigures("Reajuste de 8% a 12%, juros de 1% ao mês e taxa de R$ 50", src)).toEqual(["1%", "R$ 50"]);
    // Ponto final da frase não faz o valor "sumir" do material.
    expect(unsupportedFigures("A taxa é R$ 50.", ["A taxa é R$ 50"])).toEqual([]);
    expect(unsupportedFigures("Valor: R$ 1.290,00", src)).toEqual([]);
  });

  it("valores por extenso também contam", async () => {
    const { unsupportedFigures } = await import("../ground-reply");
    expect(unsupportedFigures("Sim, você paga 50 por cento da parcela.", ["Inclua o item na área do cliente."])).toEqual(["50 por cento"]);
    expect(unsupportedFigures("Sim, cinquenta por cento.", ["Sem valores aqui."])).toEqual(["cinquenta por cento"]);
    expect(unsupportedFigures("Fica a metade do valor.", ["Sem valores aqui."])).toEqual(["metade do valor"]);
    // Na fonte com %, ou a mesma frase: ok.
    expect(unsupportedFigures("Você paga 50 por cento.", ["O item custa 50% da parcela."])).toEqual([]);
    expect(unsupportedFigures("Fica a metade do valor.", ["O item custa 50% da parcela."])).toEqual([]);
  });

  it("reconhece resposta repetida e deixa passar a que mudou", async () => {
    const { isNearDuplicateReply } = await import("../ground-reply");
    expect(isNearDuplicateReply("Os plantões de outubro começam no dia 01/10/2026. Se precisar, é só avisar!", "Os plantões de outubro começam no dia 01/10/2026. Se precisar, é só avisar!")).toBe(true);
    expect(isNearDuplicateReply("Isso, dia 01/10. Ficou alguma dúvida sobre o começo dos plantões?", "Os plantões de outubro começam no dia 01/10/2026. Se precisar, é só avisar!")).toBe(false);
  });
});

describe("clientNamesBoundToFacts", () => {
  it("nome que só o cliente usou, ligado a data, é marcado", async () => {
    const { clientNamesBoundToFacts } = await import("../ground-reply");
    const sources = ["Agenda: Revisão R1 dos equipamentos de outubro de 6 a 9 de novembro. Revisão da filial Centro em 10/11."];
    const reply = "Para a filial Pinheiros, referente ao mês de outubro, a Revisão R1 será realizada de 6 a 9 de novembro.";
    expect(clientNamesBoundToFacts(reply, ["quando é a revisão da pinheiros?"], sources)).toEqual(["Pinheiros"]);
  });

  it("não marca: nome que está nas fontes, frase sem data/valor, início de frase", async () => {
    const { clientNamesBoundToFacts } = await import("../ground-reply");
    const sources = ["Revisão da filial Centro em 10/11."];
    expect(clientNamesBoundToFacts("A revisão da filial Centro é em 10/11.", ["e a centro?"], sources)).toEqual([]);
    expect(clientNamesBoundToFacts("Na filial Pinheiros, abra o app e veja a aba Agenda.", ["pinheiros"], sources)).toEqual([]);
    expect(clientNamesBoundToFacts("Pinheiros: revisões de 6 a 9 de novembro.", ["pinheiros"], sources)).toEqual([]);
  });
});

describe("admittedMissingInstructions e procedureAdmittedMissing", () => {
  it("instrução sobre o assunto que a própria decisão admite não ter no material é desautorizada; sobre outro assunto, fica", async () => {
    const { admittedMissingInstructions, procedureAdmittedMissing } = await import("../ground-reply");
    const reason = "A possibilidade de parcelamento não está especificada no material, mas dá para orientar o acesso.";
    const reply = "Acesse o portal e confira a opção de parcelamento. Para ver a fatura, clique em Pagamentos.";
    expect(admittedMissingInstructions(reply, reason)).toEqual(["Acesse o portal e confira a opção de parcelamento."]);
    expect(procedureAdmittedMissing(reply, reason)).toBe(true);
    expect(procedureAdmittedMissing("Para ver a fatura, clique em Pagamentos.", reason)).toBe(false);
  });

  it("admissão sem assunto nomeado desautoriza toda instrução; sem admissão, nada", async () => {
    const { admittedMissingInstructions } = await import("../ground-reply");
    expect(admittedMissingInstructions("Abra o aplicativo e toque em Perfil.", "Não há informação sobre isso nos materiais.")).toEqual(["Abra o aplicativo e toque em Perfil."]);
    expect(admittedMissingInstructions("Abra o aplicativo e toque em Perfil.", "O material descreve o passo a passo do perfil.")).toEqual([]);
    expect(admittedMissingInstructions("Abra o aplicativo e toque em Perfil.", undefined)).toEqual([]);
  });

  it("a admissão é reconhecida mesmo com acento logo depois do verbo (“não está”, “não há”) — o \b não casa depois de vogal acentuada", async () => {
    const { procedureAdmittedMissing } = await import("../ground-reply");
    expect(procedureAdmittedMissing("Acesse a área de cancelamento e selecione a opção.", "O procedimento de cancelamento não está descrito no material.")).toBe(true);
    expect(procedureAdmittedMissing("Acesse a área de renovação e selecione a opção.", "Não há orientação sobre renovação na base.")).toBe(true);
    // Fato da situação do cliente, não admissão sobre o material.
    expect(procedureAdmittedMissing("Acesse a área de renovação e selecione a opção.", "A renovação não consta no cadastro do cliente.")).toBe(false);
  });
});

describe("conta conferida com valores das fontes", () => {
  it("valor que é diferença ou soma de dois valores das fontes passa; conta errada continua sem fonte", async () => {
    const { moneyDerivations, unsupportedFigures } = await import("../ground-reply");
    const doc = "[Documento enviado pelo cliente]: Valor do Documento R$ 795,61 * DESCONTO DE R$ 659,71 ATE 13/10/26; R$ 641,59 ATE 26/10/26;";
    const reply = "O valor cheio é R$ 795,61. Pagando até 13/10 você paga R$ 135,90; até 26/10, R$ 154,02.";
    expect(unsupportedFigures(reply, [doc])).toEqual([]);
    expect(moneyDerivations(reply, [doc])).toEqual([
      { token: "R$ 135,90", expr: "R$ 795,61 − R$ 659,71" },
      { token: "R$ 154,02", expr: "R$ 795,61 − R$ 641,59" },
    ]);
    expect(unsupportedFigures("Até 13/10 você paga R$ 136,00.", [doc])).toEqual(["R$ 136,00"]);
    expect(unsupportedFigures("As duas parcelas somam R$ 1.437,20.", ["Parcela 1: R$ 795,61. Parcela 2: R$ 641,59."])).toEqual([]);
  });
});

describe("resposta que reescreve a mensagem do cliente", () => {
  it("detecta a cópia; resposta que responde ao assunto não conta", async () => {
    const { echoesClientText } = await import("../ground-reply");
    expect(echoesClientText('Boa tarde! Eu havia entrado em contato antes porque não aparecia a cobrança de outubro. Vocês informaram que estava tudo normal, pois eu não teria pedidos nesse mês. Agora consta uma cobrança de outubro em aberto, mas não tenho nenhum pedido para esse mês. Poderiam verificar?', 'manda assim: Boa tarde, eu havia entrado em contato antes porque não aparecia a cobrança de outubro, e vocês informaram que estava tudo normal, pois eu não teria pedidos nesse mês. Agora consta uma cobrança de outubro em aberto, mas eu não tenho nenhum pedido para esse mês.')).toBe(true);
    expect(echoesClientText('Entendi: aparece uma cobrança de outubro em aberto sem pedido no mês. Vou pedir para a equipe financeira conferir esse lançamento.', 'manda assim: Boa tarde, eu havia entrado em contato antes porque não aparecia a cobrança de outubro, e vocês informaram que estava tudo normal, pois eu não teria pedidos nesse mês. Agora consta uma cobrança de outubro em aberto, mas eu não tenho nenhum pedido para esse mês.')).toBe(false);
    expect(echoesClientText("Ok, entendi.", "ok")).toBe(false);
  });
});
