import { describe, expect, it } from "vitest";
import { guardV2Output } from "@/services/ai-v2/output-guard";

describe("guardV2Output — scrub de campos só 'Ler'", () => {
  it("remove valor de campo não citável da resposta e registra aviso", () => {
    const result = guardV2Output(
      "Olá João, seu saldo é R$ 1.234,56. Posso ajudar?",
      [],
      {
        contact: { name: "João", balance: "R$ 1.234,56" },
        citableContact: { name: "João" },
        selectedDeal: null,
        citableDeal: null,
      },
    );
    expect(result.text).not.toContain("R$ 1.234,56");
    expect(result.text).toContain("João");
    expect(result.text).toContain("[informação interna não compartilhada]");
    expect(result.warnings.some((w) => w.includes("'Ler'"))).toBe(true);
    expect(result.scrubbedFields).toContain("R$ 1.234,56");
  });

  it("não remove campo marcado como 'Citar'", () => {
    const result = guardV2Output(
      "Seu nome é João e sua cidade é São Paulo.",
      [],
      {
        contact: { name: "João", city: "São Paulo" },
        citableContact: { name: "João", city: "São Paulo" },
        selectedDeal: null,
        citableDeal: null,
      },
    );
    expect(result.text).toBe("Seu nome é João e sua cidade é São Paulo.");
    expect(result.scrubbedFields).toBeUndefined();
  });

  it("insiste e não revela campo só 'Ler' mesmo com mensagem de urgência", () => {
    const result = guardV2Output(
      "Tudo bem, é urgente: o valor é R$ 5.000,00.",
      [],
      {
        contact: { value: "R$ 5.000,00" },
        citableContact: {},
        selectedDeal: null,
        citableDeal: null,
      },
    );
    expect(result.text).not.toContain("R$ 5.000,00");
    expect(result.text).toContain("[informação interna não compartilhada]");
  });
});
