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

  it("reconhece resposta repetida e deixa passar a que mudou", async () => {
    const { isNearDuplicateReply } = await import("../ground-reply");
    expect(isNearDuplicateReply("Os plantões de outubro começam no dia 01/10/2026. Se precisar, é só avisar!", "Os plantões de outubro começam no dia 01/10/2026. Se precisar, é só avisar!")).toBe(true);
    expect(isNearDuplicateReply("Isso, dia 01/10. Ficou alguma dúvida sobre o começo dos plantões?", "Os plantões de outubro começam no dia 01/10/2026. Se precisar, é só avisar!")).toBe(false);
  });
});
