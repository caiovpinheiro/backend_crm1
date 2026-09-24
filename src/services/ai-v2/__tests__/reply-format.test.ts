import { describe, expect, it } from "vitest";

import { breakInlineSteps } from "../reply-format";

describe("breakInlineSteps", () => {
  it("quebra passo a passo escrito numa linha só", () => {
    const r = breakInlineSteps('Siga este passo a passo: 1. Acesse sua área. 2. Clique em "Vida". 3. Selecione o documento. Se precisar, avise!');
    expect(r).toBe('Siga este passo a passo:\n1. Acesse sua área.\n2. Clique em "Vida".\n3. Selecione o documento. Se precisar, avise!');
  });

  it("não mexe em lista que já está em linhas", () => {
    const t = "Passos:\n1. Acesse.\n2. Clique.";
    expect(breakInlineSteps(t)).toBe(t);
  });

  it("não mexe em número solto nem em sequência que não começa em 1", () => {
    for (const t of ["A prova será de 6 a 9. Depois vem a AF.", "Temos 2. opções e 3. prazos", "Custa R$ 10. Pague até dia 5."]) {
      expect(breakInlineSteps(t)).toBe(t);
    }
  });
});
