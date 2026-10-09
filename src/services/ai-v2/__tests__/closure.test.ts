import { describe, expect, it } from "vitest";

import { isExplicitResolution } from "../closure";

describe("isExplicitResolution — o cliente disse que acabou", () => {
  it("confirmação de leitura não é resolução", () => {
    for (const t of ["Ok", "certo", "beleza", "👍", "entendi", "obrigado"]) expect(isExplicitResolution(t)).toBe(false);
  });

  it("resolução com palavras", () => {
    for (const t of ["Resolvido, obrigada!", "não preciso de mais nada", "era só isso", "pode encerrar", "consegui, valeu"]) {
      expect(isExplicitResolution(t)).toBe(true);
    }
  });

  it("negação não conta", () => {
    expect(isExplicitResolution("não consegui")).toBe(false);
    expect(isExplicitResolution("não funcionou")).toBe(false);
  });
});
