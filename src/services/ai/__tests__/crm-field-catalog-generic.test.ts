/**
 * O catálogo de campos serve QUALQUER organização.
 *
 * O que este teste protege: nenhuma entidade, chave ou termo de ramo está
 * embutido no código. A organização aqui é uma imobiliária — nada de
 * faculdade envolvido — e o catálogo dela sai inteiro das definições de
 * `CustomField` que ela criou, inclusive uma entidade que o motor ainda não
 * sabe ler.
 */
import { describe, expect, it, vi } from "vitest";

/// Definições de UMA imobiliária. Este array é o "banco" da org no teste.
const IMOBILIARIA_FIELDS = [
  { entity: "deal", name: "codigo_imovel", label: "Código do imóvel", type: "TEXT" },
  { entity: "deal", name: "valor_avaliacao", label: "Valor de avaliação", type: "NUMBER" },
  { entity: "deal", name: "tipo_negocio", label: "Locação ou venda", type: "SELECT" },
  { entity: "deal", name: "vistoria_feita", label: "Vistoria realizada", type: "BOOLEAN" },
  { entity: "contact", name: "creci", label: "CRECI do corretor", type: "TEXT" },
  { entity: "contact", name: "renda_familiar", label: "Renda familiar", type: "NUMBER" },
  { entity: "company", name: "administradora", label: "Administradora", type: "TEXT" },
  // Entidade que o motor NÃO sabe procurar hoje. A API de campos
  // personalizados aceita qualquer string em `entity`, então isto é
  // alcançável sem deploy.
  { entity: "property", name: "matricula_registro", label: "Matrícula do registro", type: "TEXT" },
];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customField: { findMany: vi.fn(async () => IMOBILIARIA_FIELDS) },
  },
}));

import {
  loadCrmFieldCatalog,
  partitionFieldValues,
  emptyCrmFieldExposure,
  matchFieldValues,
  type CrmFieldValue,
} from "@/services/ai/crm-field-policy";

const catalog = () => loadCrmFieldCatalog();
const keys = (fields: Array<{ key: string }>) => fields.map((f) => f.key);

describe("catálogo de uma organização não-acadêmica", () => {
  it("monta os campos personalizados que a org definiu", async () => {
    const { fields } = await catalog();
    for (const k of [
      "deal.codigo_imovel",
      "deal.valor_avaliacao",
      "deal.tipo_negocio",
      "contact.creci",
      "contact.renda_familiar",
      "company.administradora",
    ]) {
      expect(keys(fields)).toContain(k);
    }
  });

  it("não injeta campo de outra org em lugar nenhum", async () => {
    const { fields } = await catalog();
    const custom = fields.filter((f) => f.source === "custom");
    // Todo campo personalizado do catálogo saiu do "banco" desta org.
    for (const f of custom) {
      expect(
        IMOBILIARIA_FIELDS.some(
          (d) => d.entity === f.entity && d.name === f.name,
        ),
        `${f.key} não foi definido por esta org`,
      ).toBe(true);
    }
    const serialized = JSON.stringify(fields).toLowerCase();
    for (const alheio of ["curso", "polo", "rgm", "acessoblack", "aluno"]) {
      expect(serialized, `catálogo cita "${alheio}"`).not.toContain(alheio);
    }
  });

  it("entidade nova aparece sozinha, marcada como ainda não legível", async () => {
    const { entities } = await catalog();
    const property = entities.find((e) => e.entity === "property");
    expect(property, "entidade declarada pela org não apareceu").toBeDefined();
    expect(property?.customCount).toBe(1);
    expect(property?.builtinCount).toBe(0);
    // Honestidade em vez de sumiço: o motor não tem tabela de valores nem
    // query de registro para ela, e isso é dito.
    expect(property?.searchable).toBe(false);
    expect(property?.customValuesSupported).toBe(false);
    expect(property?.fields[0].valueAvailable).toBe(false);
  });

  it("company aceita definição mas não tem onde guardar valor", async () => {
    const { entities } = await catalog();
    const company = entities.find((e) => e.entity === "company");
    expect(company?.searchable).toBe(true);
    expect(company?.customValuesSupported).toBe(false);
    const administradora = company?.fields.find(
      (f) => f.name === "administradora",
    );
    expect(administradora?.valueAvailable).toBe(false);
  });

  it("agrupa por entidade com rótulo e curinga para a tela", async () => {
    const { entities } = await catalog();
    const deal = entities.find((e) => e.entity === "deal");
    expect(deal?.label).toBe("Negócios");
    expect(deal?.wildcardKey).toBe("deal.*");
    expect(deal?.customCount).toBe(4);
    expect(deal?.builtinCount).toBeGreaterThan(0);
    // Entidade sem campo personalizado nenhum continua listada, com contagem
    // zero — a tela precisa disso para mostrar o estado vazio.
    const product = entities.find((e) => e.entity === "product");
    expect(product?.customCount).toBe(0);
    expect(product?.builtinCount).toBeGreaterThan(0);
  });

  it("acende o aviso em dado pessoal e não em campo de operação", async () => {
    const { fields } = await catalog();
    const hint = (key: string) =>
      fields.find((f) => f.key === key)?.sensitiveHint;
    expect(hint("contact.renda_familiar")).toBe(true);
    expect(hint("deal.codigo_imovel")).toBe(false);
    expect(hint("deal.vistoria_feita")).toBe(false);
  });
});

describe("leitura numa organização não-acadêmica", () => {
  async function valuesOf(pairs: Record<string, string>) {
    const { fields } = await catalog();
    const out: CrmFieldValue[] = [];
    for (const [key, value] of Object.entries(pairs)) {
      const field = fields.find((f) => f.key === key);
      if (!field) throw new Error(`campo ${key} não está no catálogo`);
      out.push({ field, value });
    }
    return out;
  }

  it("o default nega tudo, inclusive campo trivial", async () => {
    const values = await valuesOf({
      "deal.codigo_imovel": "AP-4471",
      "deal.tipo_negocio": "Locação",
      "contact.renda_familiar": "8500",
    });
    const { visible, hiddenLabels } = partitionFieldValues(
      values,
      emptyCrmFieldExposure(),
    );
    expect(visible).toEqual([]);
    expect(hiddenLabels).toEqual([
      "Código do imóvel",
      "Locação ou venda",
      "Renda familiar",
    ]);
  });

  it("liberar uma chave arbitrária desta org funciona", async () => {
    const values = await valuesOf({
      "deal.codigo_imovel": "AP-4471",
      "deal.tipo_negocio": "Locação",
      "contact.renda_familiar": "8500",
    });
    const { visible, hiddenLabels } = partitionFieldValues(values, {
      readableKeys: ["deal.codigo_imovel", "deal.tipo_negocio"],
      orgWide: false,
    });
    expect(visible).toEqual([
      { label: "Código do imóvel", value: "AP-4471" },
      { label: "Locação ou venda", value: "Locação" },
    ]);
    expect(hiddenLabels).toEqual(["Renda familiar"]);
    expect(JSON.stringify(visible)).not.toContain("8500");
  });

  it("a busca casa num campo retido sem devolver o valor", async () => {
    const values = await valuesOf({ "contact.renda_familiar": "8500" });
    const { matched, matchedLabels } = matchFieldValues(values, "8500");
    expect(matched).toBe(true);
    expect(matchedLabels).toEqual(["Renda familiar"]);
    const { visible } = partitionFieldValues(values, emptyCrmFieldExposure());
    expect(visible).toEqual([]);
  });
});
