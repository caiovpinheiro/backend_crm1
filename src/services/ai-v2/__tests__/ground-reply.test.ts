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
