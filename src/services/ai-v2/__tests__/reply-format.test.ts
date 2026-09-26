import { describe, expect, it } from "vitest";

import { applyBoldPolicy, boldInstruction, breakInlineSteps } from "../reply-format";

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
    for (const t of ["O evento será de 6 a 9. Depois vem a etapa B.", "Temos 2. opções e 3. prazos", "Custa R$ 10. Pague até dia 5."]) {
      expect(breakInlineSteps(t)).toBe(t);
    }
  });
});

describe("applyBoldPolicy", () => {
  it("Markdown vira negrito do WhatsApp em qualquer modo", () => {
    expect(applyBoldPolicy("Toque em **Pagar**.", "auto")).toBe("Toque em *Pagar*.");
  });

  it("sem negrito: tira os destaques, mantém marcadores de lista", () => {
    expect(applyBoldPolicy("Prazo: *19/10*. Toque em **Pagar**.", "off")).toBe("Prazo: 19/10. Toque em Pagar.");
    expect(applyBoldPolicy("* item um\n* item dois", "off")).toBe("* item um\n* item dois");
  });

  it("destacar o importante: tira de link, de frase longa e o excesso", () => {
    expect(applyBoldPolicy("Acesse *https://exemplo.com/x* agora.", "key")).toBe("Acesse https://exemplo.com/x agora.");
    expect(applyBoldPolicy("*Esta frase inteira ficou em negrito sem motivo nenhum*.", "key")).toBe("Esta frase inteira ficou em negrito sem motivo nenhum.");
    const five = "*a1* *b2* *c3* *d4* *e5*";
    expect(applyBoldPolicy(five, "key")).toBe("*a1* *b2* *c3* *d4* e5");
  });

  it("instrução só nos modos que pedem", () => {
    expect(boldInstruction("auto")).toBeNull();
    expect(boldInstruction(undefined)).toBeNull();
    expect(boldInstruction("key")).toContain("datas");
    expect(boldInstruction("off")).toContain("Não use negrito");
  });
});
