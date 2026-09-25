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
});

describe("unsupportedFigures e isNearDuplicateReply", () => {
  it("aponta percentual e valor que não estão nas fontes", async () => {
    const { unsupportedFigures } = await import("../ground-reply");
    const src = ["O reajuste é de 8% a 12% ao ano. Taxa de R$ 1.290,00."];
    expect(unsupportedFigures("Reajuste de 8% a 12%, juros de 1% ao mês e taxa de R$ 50", src)).toEqual(["1%", "R$ 50"]);
    expect(unsupportedFigures("Valor: R$ 1.290,00", src)).toEqual([]);
  });

  it("reconhece resposta repetida e deixa passar a que mudou", async () => {
    const { isNearDuplicateReply } = await import("../ground-reply");
    expect(isNearDuplicateReply("As aulas de outubro começam no dia 01/10/2026. Se precisar, é só avisar!", "As aulas de outubro começam no dia 01/10/2026. Se precisar, é só avisar!")).toBe(true);
    expect(isNearDuplicateReply("Isso, dia 01/10. Ficou alguma dúvida sobre o começo das aulas?", "As aulas de outubro começam no dia 01/10/2026. Se precisar, é só avisar!")).toBe(false);
  });
});
