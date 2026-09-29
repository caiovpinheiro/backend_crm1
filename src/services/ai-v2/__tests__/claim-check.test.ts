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
