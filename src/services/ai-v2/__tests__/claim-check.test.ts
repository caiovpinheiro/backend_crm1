import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));

import { buildClaimCheckInput, parseClaimCheck, worthClaimCheck } from "../claim-check";

describe("checagem por modelo — auxiliares", () => {
  it("só confere resposta com conteúdo", () => {
    expect(worthClaimCheck("Por nada!")).toBe(false);
    expect(worthClaimCheck("Qual o número do seu pedido? E a data da compra?")).toBe(false);
    expect(worthClaimCheck("A instalação é gratuita para todos os planos.")).toBe(true);
  });

  it("lê o JSON e descarta trecho que não está na resposta", () => {
    const reply = "A instalação é gratuita. O técnico vai em até 2 dias.";
    expect(parseClaimCheck('```json\n{"unsupported": ["A instalação é gratuita", "garantia de 5 anos"]}\n```', reply)).toEqual(["A instalação é gratuita"]);
    expect(parseClaimCheck("não sei", reply)).toEqual([]);
    expect(parseClaimCheck('{"unsupported": []}', reply)).toEqual([]);
  });

  it("separa fontes do que o cliente disse", () => {
    const t = buildClaimCheckInput({ reply: "Sim, R$ 30.", sources: ["Taxa de entrega: R$ 15"], clientTexts: ["a taxa é R$ 30, né?"] });
    expect(t).toContain("[1] Taxa de entrega: R$ 15");
    expect(t).toContain("O que o cliente disse (não é fonte):\n- a taxa é R$ 30, né?");
  });
});

describe("documento do cliente e conta conferida na checagem", () => {
  it("o texto do documento e as contas vão ao checador como fonte", async () => {
    const { buildClaimCheckInput, clientDocumentTexts } = await import("../claim-check");
    const clientTexts = ['não entendi o valor\n[Documento enviado pelo cliente ("fatura.pdf")]: Valor do documento R$ 300,00\nDesconto de R$ 120,00 até 13/10'];
    const docs = clientDocumentTexts(clientTexts);
    expect(docs).toEqual(["Valor do documento R$ 300,00\nDesconto de R$ 120,00 até 13/10"]);
    const input = buildClaimCheckInput({ reply: "x", sources: ["s"], clientTexts, clientDocuments: docs, derivedAmounts: ["R$ 180,00 = R$ 300,00 − R$ 120,00"] });
    expect(input).toContain("Documentos e imagens que o cliente enviou");
    expect(input).toContain("Desconto de R$ 120,00 até 13/10");
    expect(input).toContain("- R$ 180,00 = R$ 300,00 − R$ 120,00");
  });

  it("marcação com a conta conferida e números do documento é descartada; com número de fora, fica", async () => {
    const { claimBackedByArithmetic } = await import("../claim-check");
    const docs = ["Valor do documento R$ 300,00\nDesconto de R$ 120,00 até 13/10/26"];
    const derived = ["R$ 180,00 = R$ 300,00 − R$ 120,00"];
    expect(claimBackedByArithmetic("pagando até 13/10 você paga R$ 180,00", derived, docs)).toBe(true);
    expect(claimBackedByArithmetic("pagando até 20/10 você paga R$ 180,00", derived, docs)).toBe(false);
    expect(claimBackedByArithmetic("o desconto vale até 13/10", derived, docs)).toBe(false);
    expect(claimBackedByArithmetic("você paga R$ 180,00", [], docs)).toBe(false);
  });
});
