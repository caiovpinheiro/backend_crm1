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
  emptyToolPolicy,
  normalizeToolPolicy,
  isEmptyToolPolicy,
} from "@/lib/ai-agents/steering";
import {
  describeCrmIdentity,
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
    readable: true,
  };
}

const catalog = [
  field("deal.RGM", "RGM"),
  field("deal.curso", "curso"),
  field("contact.cpf", "cpf"),
  field("product.sku", "SKU"),
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

/**
 * Só registro de PESSOA identifica alguém. Deixar o SKU de um item do
 * catálogo servir de identificador abriria o cadastro de quem comprou ele.
 */
describe("fonte que não é de pessoa nunca identifica", () => {
  const pessoas = new Set(["deal", "contact"]);

  it("chave de entidade de pessoa passa", () => {
    const out = resolveIdentityFields(catalog, ["deal.RGM"], pessoas);
    expect(out.map((f) => f.key)).toEqual(["deal.RGM"]);
  });

  it("chave de catálogo é descartada mesmo se o operador declarou", () => {
    expect(resolveIdentityFields(catalog, ["product.sku"], pessoas)).toEqual(
      [],
    );
  });
});

/**
 * O modelo mapeia "minha matrícula é 987654" no campo certo pelo RÓTULO do
 * tenant. Sem ele o núcleo teria de saber o que "matrícula" significa.
 */
describe("descrição da identificação no prompt", () => {
  it("sem chave declarada, proíbe pedir número", () => {
    const txt = describeCrmIdentity([]);
    expect(txt).toContain("NÃO peça");
  });

  it("leva a chave E o rótulo do tenant", () => {
    const txt = describeCrmIdentity([
      { key: "deal.rgm", label: "Matrícula (RGM)" },
      { key: "deal.numero_pedido", label: "Número do pedido" },
    ]);
    expect(txt).toContain("deal.rgm");
    expect(txt).toContain("Matrícula (RGM)");
    expect(txt).toContain("Número do pedido");
    expect(txt).toContain("exato");
  });

  it("chave sem rótulo próprio não vira linha duplicada", () => {
    const txt = describeCrmIdentity([
      { key: "deal.codigo", label: "deal.codigo" },
    ]);
    expect(txt).toContain("- deal.codigo\n");
  });
});
