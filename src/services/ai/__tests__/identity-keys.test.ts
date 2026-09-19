/**
 * Chaves de identificação: o número que a pessoa informa no chat para ser
 * localizada.
 *
 * O que estes testes prendem, em ordem de importância:
 *  1. agente sem configuração se comporta exatamente como antes;
 *  2. identificar não é o mesmo que poder ler o valor;
 *  3. casamento é exato — prefixo/sufixo não abre o registro de outro;
 *  4. curinga não identifica nada.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeAcademicIdentityKeys,
  describeAcademicIdentity,
} from "@/services/ai/academic-record-policy";
import {
  emptyToolPolicy,
  normalizeToolPolicy,
  isEmptyToolPolicy,
} from "@/lib/ai-agents/steering";
import {
  identityValueMatches,
  normalizeIdentityValue,
  resolveIdentityFields,
  type CrmFieldDescriptor,
} from "@/services/ai/crm-field-policy";

function field(key: string, name: string): CrmFieldDescriptor {
  const [entity] = key.split(".");
  return {
    key,
    entity,
    name,
    label: name,
    source: "custom",
    type: "TEXT",
    sensitiveHint: false,
    valueAvailable: true,
  };
}

const catalog = [
  field("deal.RGM", "RGM"),
  field("deal.curso", "curso"),
  field("contact.cpf", "cpf"),
];

describe("ToolPolicy.identityKeys", () => {
  it("default é vazio — nada é identificador por conta do código", () => {
    expect(emptyToolPolicy().identityKeys).toEqual([]);
    expect(normalizeToolPolicy({}).identityKeys).toEqual([]);
  });

  it("policy só com identityKeys não é considerada vazia", () => {
    const p = normalizeToolPolicy({ identityKeys: ["deal.RGM"] });
    expect(p.identityKeys).toEqual(["deal.RGM"]);
    expect(isEmptyToolPolicy(p)).toBe(false);
  });

  it("descarta lixo e duplicata, como as outras listas", () => {
    const p = normalizeToolPolicy({
      identityKeys: ["deal.RGM", "deal.RGM", "", 42, null],
    });
    expect(p.identityKeys).toEqual(["deal.RGM"]);
  });
});

describe("resolveIdentityFields", () => {
  it("resolve a chave exata", () => {
    const out = resolveIdentityFields(catalog, ["deal.RGM"]);
    expect(out.map((f) => f.key)).toEqual(["deal.RGM"]);
  });

  it("curinga NÃO identifica nada", () => {
    expect(resolveIdentityFields(catalog, ["deal.*"])).toEqual([]);
    expect(resolveIdentityFields(catalog, ["*"])).toEqual([]);
  });

  it("chave órfã (campo apagado) some em silêncio", () => {
    expect(resolveIdentityFields(catalog, ["deal.naoExiste"])).toEqual([]);
  });

  it("sem configuração, nenhum campo identifica", () => {
    expect(resolveIdentityFields(catalog, [])).toEqual([]);
  });
});

describe("casamento exato", () => {
  it("ignora máscara e caixa dos dois lados", () => {
    expect(identityValueMatches("12.345-678", "12345678")).toBe(true);
    expect(identityValueMatches("12345678", " 12.345.678 ")).toBe(true);
    expect(identityValueMatches("AB-123", "ab123")).toBe(true);
  });

  it("valor parcial NÃO casa", () => {
    expect(identityValueMatches("12345678", "1234")).toBe(false);
    expect(identityValueMatches("12345678", "45678")).toBe(false);
    expect(identityValueMatches("123456789", "12345678")).toBe(false);
  });

  it("vazio nunca casa", () => {
    expect(identityValueMatches("", "")).toBe(false);
    expect(identityValueMatches("  ", "12345678")).toBe(false);
  });

  it("valor com letra não é reduzido a dígitos", () => {
    // Senão "AB-123" viraria "123" e colidiria com o registro "123".
    expect(normalizeIdentityValue("AB-123")).toBe("ab123");
    expect(identityValueMatches("AB-123", "123")).toBe(false);
  });
});

describe("identificadores do domínio acadêmico", () => {
  it("sem configuração não há identificador e o texto proíbe pedir", () => {
    expect(normalizeAcademicIdentityKeys([])).toEqual([]);
    const txt = describeAcademicIdentity([]);
    expect(txt).toContain("NUNCA peça");
  });

  it("aceita a chave com e sem prefixo", () => {
    expect(normalizeAcademicIdentityKeys(["rgm"])).toEqual(["rgm"]);
    expect(normalizeAcademicIdentityKeys(["matricula.rgm"])).toEqual(["rgm"]);
  });

  it("curinga não libera identificador", () => {
    expect(normalizeAcademicIdentityKeys(["*"])).toEqual([]);
    expect(normalizeAcademicIdentityKeys(["matricula.*"])).toEqual([]);
  });

  it("descarta chave que o lookup não sabe consultar", () => {
    expect(normalizeAcademicIdentityKeys(["curso", "polo"])).toEqual([]);
  });

  it("o texto nomeia o identificador aceito e veta afirmar inexistência", () => {
    const txt = describeAcademicIdentity(["rgm"]);
    expect(txt).toContain("RGM");
    expect(txt).toContain("identificador");
    expect(txt.toLowerCase()).toContain("não existe");
  });
});
