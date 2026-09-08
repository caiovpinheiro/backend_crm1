import { describe, expect, it } from "vitest";

import {
  CRM_SEARCH_GUIDANCE,
  crmFieldKey,
  describeCrmExposure,
  emptyCrmFieldExposure,
  isFieldReadable,
  looksSensitive,
  matchFieldValues,
  partitionFieldValues,
  type CrmFieldDescriptor,
  type CrmFieldValue,
} from "@/services/ai/crm-field-policy";
import {
  emptyToolPolicy,
  isEmptyToolPolicy,
  normalizeToolConfig,
  normalizeToolPolicy,
} from "@/lib/ai-agents/steering";

function field(
  name: string,
  label: string,
  entity = "deal",
  extraTerms: string[] = [],
): CrmFieldDescriptor {
  return {
    key: crmFieldKey(entity, name),
    entity,
    name,
    label,
    source: "custom",
    type: "TEXT",
    sensitiveHint: looksSensitive(name, label, extraTerms),
    valueAvailable: true,
  };
}

/// Campos personalizados de uma organização qualquer — aqui uma faculdade,
/// só porque é o caso que originou a feature. Nada disso vive no código.
const values: CrmFieldValue[] = [
  { field: field("curso", "Curso"), value: "PEDAGOGIA" },
  { field: field("cpf", "CPF"), value: "12345678901" },
  { field: field("rgm", "RGM"), value: "20231234" },
  { field: field("situacao_matricula", "Situação Matrícula"), value: "EM CURSO" },
  { field: field("inadimplente", "Inadimplente"), value: "SIM" },
  { field: field("doc_pendentes", "Doc pendentes"), value: "NAO" },
];

describe("exposição de campo (default-deny)", () => {
  it("agente sem configuração não recebe nenhum valor", () => {
    const { visible, hiddenLabels } = partitionFieldValues(
      values,
      emptyCrmFieldExposure(),
    );
    expect(visible).toEqual([]);
    expect(hiddenLabels).toContain("CPF");
    expect(hiddenLabels).toContain("Curso");
  });

  it("nenhum valor sensível é serializado quando o campo não foi liberado", () => {
    const partition = partitionFieldValues(values, {
      readableKeys: ["deal.curso"],
      orgWide: false,
    });
    const serialized = JSON.stringify(partition);
    for (const leak of ["12345678901", "20231234", "EM CURSO", "SIM"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(partition.visible).toEqual([{ label: "Curso", value: "PEDAGOGIA" }]);
  });

  it("o rótulo do campo retido chega ao modelo, o conteúdo não", () => {
    const { hiddenLabels } = partitionFieldValues(values, {
      readableKeys: ["deal.curso"],
      orgWide: false,
    });
    // Saber que o dado EXISTE é o que permite encaminhar em vez de negar.
    expect(hiddenLabels).toEqual([
      "CPF",
      "RGM",
      "Situação Matrícula",
      "Inadimplente",
      "Doc pendentes",
    ]);
  });

  it("curinga por entidade e global são decisão explícita do operador", () => {
    const exposure = { readableKeys: ["deal.*"], orgWide: false };
    expect(isFieldReadable(exposure, "deal.cpf")).toBe(true);
    expect(isFieldReadable(exposure, "contact.email")).toBe(false);
    expect(
      isFieldReadable({ readableKeys: ["*"], orgWide: false }, "contact.email"),
    ).toBe(true);
  });

  it("a chave tolera acento e caixa", () => {
    const exposure = { readableKeys: ["Deal.Curso"], orgWide: false };
    expect(isFieldReadable(exposure, "deal.curso")).toBe(true);
  });

  it("campo vazio não vira rótulo oculto", () => {
    const { hiddenLabels } = partitionFieldValues(
      [{ field: field("polo", "Polo"), value: "   " }],
      emptyCrmFieldExposure(),
    );
    expect(hiddenLabels).toEqual([]);
  });
});

describe("busca ampla", () => {
  it("casa pelo valor de um campo que o modelo não pode ler", () => {
    // A pessoa digita o próprio documento: a busca acha, o valor não volta.
    const { matched, matchedLabels } = matchFieldValues(values, "12345678901");
    expect(matched).toBe(true);
    expect(matchedLabels).toEqual(["CPF"]);
  });

  it("casa pelo rótulo quando a pergunta usa a palavra do campo", () => {
    const { matched, matchedLabels } = matchFieldValues(values, "curso");
    expect(matched).toBe(true);
    expect(matchedLabels).toContain("Curso");
  });

  it("tolera acento e caixa", () => {
    expect(matchFieldValues(values, "SITUAÇÃO").matched).toBe(true);
    expect(matchFieldValues(values, "situacao").matched).toBe(true);
  });

  it("termo inexistente não casa", () => {
    expect(matchFieldValues(values, "engenharia naval").matched).toBe(false);
  });

  it("os rótulos casados não carregam valor junto", () => {
    const { matchedLabels } = matchFieldValues(values, "20231234");
    expect(JSON.stringify(matchedLabels)).not.toContain("20231234");
  });
});

describe("aviso de sensibilidade", () => {
  it("marca dado pessoal que existe em qualquer ramo", () => {
    for (const [name, label] of [
      ["cpf", "CPF"],
      ["cnpj_empresa", "CNPJ"],
      ["data_de_nascimento", "Data Nascimento"],
      ["email_alternativo", "E-mail alternativo"],
      ["senha_portal", "Senha do portal"],
      ["renda_familiar", "Renda familiar"],
      ["inadimplente", "Inadimplente"],
    ]) {
      expect(looksSensitive(name, label), `${name} deveria acender`).toBe(true);
    }
  });

  it("não marca campo operacional", () => {
    for (const [name, label] of [
      ["curso", "Curso"],
      ["polo", "Polo"],
      ["codigo_imovel", "Código do imóvel"],
      ["etapa", "Etapa"],
    ]) {
      expect(looksSensitive(name, label), `${name} não deveria acender`).toBe(
        false,
      );
    }
  });

  it("termo curto casa palavra inteira, não trecho de outra palavra", () => {
    // "rg" não pode acender em "argumento" nem em "rgm".
    expect(looksSensitive("rg", "RG")).toBe(true);
    expect(looksSensitive("argumento_venda", "Argumento de venda")).toBe(false);
  });

  it("jargão da organização entra por configuração, não pelo código", () => {
    // "RGM" é o nome que UMA faculdade dá ao registro dela. O produto não
    // conhece esse termo; o operador declara.
    expect(looksSensitive("rgm", "RGM")).toBe(false);
    expect(looksSensitive("rgm", "RGM", ["rgm"])).toBe(true);
    expect(looksSensitive("prontuario", "Prontuário", ["prontuario"])).toBe(
      true,
    );
  });

  it("o aviso NÃO bloqueia leitura — só a allowlist decide", () => {
    const cpf = field("cpf", "CPF");
    expect(cpf.sensitiveHint).toBe(true);
    const { visible, hiddenLabels } = partitionFieldValues(
      [{ field: cpf, value: "12345678901" }],
      { readableKeys: ["deal.cpf"], orgWide: false },
    );
    // O operador liberou: o valor sai, apesar do aviso.
    expect(visible).toEqual([{ label: "CPF", value: "12345678901" }]);
    expect(hiddenLabels).toEqual([]);
  });
});

describe("orientação e configuração", () => {
  it("a orientação não usa vocabulário de nenhum ramo", () => {
    const proibidos = [
      "aluno",
      "matrícula",
      "matricula",
      "curso",
      "instituição",
      "faculdade",
      "acadêmic",
      "RGM",
      "paciente",
      "imóvel",
    ];
    const texto = CRM_SEARCH_GUIDANCE.toLowerCase();
    for (const termo of proibidos) {
      expect(texto, `orientação cita "${termo}"`).not.toContain(
        termo.toLowerCase(),
      );
    }
  });

  it("a orientação cobre busca, redação e proibição", () => {
    for (const termo of ["hiddenFields", "fields", "QUANDO USAR", "NUNCA"]) {
      expect(CRM_SEARCH_GUIDANCE).toContain(termo);
    }
  });

  it("a description avisa o modelo quando nada foi liberado", () => {
    expect(describeCrmExposure(emptyCrmFieldExposure())).toContain(
      "não liberou nenhum campo",
    );
    expect(
      describeCrmExposure({ readableKeys: ["deal.curso"], orgWide: false }),
    ).toContain("deal.curso");
  });

  it("toolConfig carrega a allowlist do operador", () => {
    const policy = normalizeToolPolicy({
      readableFields: ["deal.curso", "deal.polo", "  ", "deal.curso"],
      allowOrgWideSearch: true,
      sensitiveTerms: ["rgm"],
    });
    expect(policy.readableFields).toEqual(["deal.curso", "deal.polo"]);
    expect(policy.allowOrgWideSearch).toBe(true);
    expect(policy.sensitiveTerms).toEqual(["rgm"]);
  });

  it("policy default não libera nada nem é persistida", () => {
    const base = emptyToolPolicy();
    expect(base.readableFields).toEqual([]);
    expect(base.allowOrgWideSearch).toBe(false);
    expect(base.sensitiveTerms).toEqual([]);
    expect(isEmptyToolPolicy(base)).toBe(true);
    expect(normalizeToolConfig({ search_crm_records: {} })).toEqual({});
  });

  it("allowlist salva sobrevive ao normalize do toolConfig", () => {
    const config = normalizeToolConfig({
      search_crm_records: { readableFields: ["deal.curso"] },
    });
    expect(config.search_crm_records.readableFields).toEqual(["deal.curso"]);
  });
});
