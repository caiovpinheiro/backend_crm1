import { describe, expect, it } from "vitest";

import { derivedFieldValue, derivedFieldValues, fieldMasks, maskFieldValue } from "@/lib/ai-v2/field-mask";
import { buildVariableMap, confirmationIdentityValues, renderMessage } from "@/lib/ai-v2/message-render";
import type { V2DerivedField } from "@/lib/ai-v2/types";

describe("máscara de campo", () => {
  it("parcial: começo e fim, pontuação preservada", () => {
    expect(maskFieldValue("218.456.789-21", "partial")).toBe("218.xxx.xxx-21");
    expect(maskFieldValue("21845678921", "partial")).toBe("218xxxxxx21");
    expect(maskFieldValue("(11) 98888-7777", "partial")).toBe("(11) 9xxxx-xx77");
    expect(maskFieldValue("1234", "partial")).toBe("xxxx");
  });

  it("e-mail: começo do usuário e domínio", () => {
    expect(maskFieldValue("maria.souza@escola.edu.br", "email")).toBe("ma***@escola.edu.br");
    expect(maskFieldValue("a@x.com", "email")).toBe("a***@x.com");
  });

  it("sem máscara: valor como está", () => {
    expect(maskFieldValue(" abc ", "none")).toBe("abc");
    expect(maskFieldValue("abc", undefined)).toBe("abc");
  });
});

describe("informação montada", () => {
  const senha: V2DerivedField = {
    id: "d1",
    label: "Senha provisória",
    parts: [
      { kind: "field", entity: "contact", key: "doc", take: "first", count: 6, digitsOnly: true },
      { kind: "text", text: "@" },
      { kind: "field", entity: "deal", key: "matricula" },
    ],
  };

  it("junta as partes na ordem", () => {
    expect(derivedFieldValue(senha, { doc: "218.456.789-21" }, { matricula: "12345" })).toBe("218456@12345");
    expect(derivedFieldValue({ ...senha, parts: [{ kind: "field", key: "doc", take: "last", count: 2, digitsOnly: true }] }, { doc: "218.456.789-21" }, null)).toBe("21");
  });

  it("campo vazio: informação vazia (nunca pela metade)", () => {
    expect(derivedFieldValue(senha, { doc: "218.456.789-21" }, {})).toBe("");
    expect(derivedFieldValues({ derivedFields: [senha] }, { doc: "" }, { matricula: "1" })).toEqual({});
  });
});

describe("variáveis e confirmação", () => {
  const policy = {
    contextFields: { contact: [{ key: "doc", label: "CPF", permissions: ["read", "cite"] as const, mask: "partial" as const }], deal: [] },
    derivedFields: [{ id: "d1", label: "Senha provisória", parts: [{ kind: "field" as const, key: "doc", take: "first" as const, count: 4, digitsOnly: true }] }],
  };

  it("@CPF sai mascarado e a informação montada vira @variável", () => {
    const vars = buildVariableMap([], null, null, { doc: "218.456.789-21", CPF: "218.456.789-21" }, null, policy as never);
    expect(renderMessage("Seu CPF é @CPF.", vars)).toBe("Seu CPF é 218.xxx.xxx-21.");
    expect(renderMessage("Sua senha provisória é @Senha provisória.", vars)).toBe("Sua senha provisória é 2184.");
  });

  it("confirmação usa a máscara", () => {
    const values = confirmationIdentityValues({
      fieldKeys: ["doc"],
      fieldLabels: policy.contextFields.contact,
      sources: [{ doc: "218.456.789-21" }],
      masks: fieldMasks(policy as never),
    });
    expect(values).toEqual(["218.xxx.xxx-21"]);
  });
});
