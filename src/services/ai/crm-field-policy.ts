/**
 * Política de exposição de campos do CRM para o agente de IA.
 *
 * O pedido era "pesquisar em todos os campos e campos personalizados". O
 * problema é que, nesta organização, quase todo campo personalizado é dado
 * pessoal: CPF, RGM, data de nascimento, e-mail acadêmico, inadimplência,
 * situação da matrícula. Despejar isso no contexto do modelo repete
 * exatamente o defeito documentado em `sensitive-fields.ts` — o agente
 * anunciou ao aluno "seu curso está cancelado" porque o dado estava no
 * payload, apesar da instrução em caixa alta pedindo sigilo. Instrução
 * dentro de payload não é mecanismo de segurança.
 *
 * A separação adotada aqui é entre BUSCAR e LER:
 *
 *  - a busca varre TODOS os campos, inclusive os sensíveis. É assim que o
 *    aluno que digita o próprio CPF encontra o próprio cadastro.
 *  - a leitura devolve só os campos que o operador liberou nominalmente.
 *    Nada é liberado por default: agente sem configuração enxerga zero
 *    valores e é instruído a encaminhar para um humano.
 *
 * Quem decide o que é legível é o operador, não este arquivo. A heurística
 * de `sensitiveHint` existe só para a tela avisar quem estiver liberando —
 * ela não bloqueia nada, porque adivinhar sensibilidade pelo nome do campo
 * seria a mesma "regra inventada" que o default-deny evita.
 */

import { prisma } from "@/lib/prisma";

export type CrmSearchEntity = "contact" | "company" | "deal" | "product";

export const CRM_SEARCH_ENTITIES: CrmSearchEntity[] = [
  "contact",
  "company",
  "deal",
  "product",
];

export type CrmFieldDescriptor = {
  /// Chave estável usada na configuração do operador: "deal.curso".
  key: string;
  entity: CrmSearchEntity;
  /// Nome técnico (coluna builtin ou `CustomField.name`).
  name: string;
  /// Rótulo que o operador vê na tela e que o modelo recebe como nome.
  label: string;
  source: "builtin" | "custom";
  /// Tipo do campo personalizado (TEXT, NUMBER, SELECT...). Null em builtin.
  type: string | null;
  /// Aviso para a tela: o campo aparenta carregar dado pessoal. Não trava
  /// nada — só sinaliza para quem for liberar.
  sensitiveHint: boolean;
};

/**
 * Campos fixos por entidade. Deliberadamente curto: colunas de rastreio
 * (utm, gclid, adResolved*), IDs internos e timestamps de sistema não têm
 * uso em atendimento e só aumentariam a superfície de exposição.
 */
const BUILTIN_FIELDS: Record<
  CrmSearchEntity,
  Array<{ name: string; label: string }>
> = {
  contact: [
    { name: "name", label: "Nome" },
    { name: "email", label: "E-mail" },
    { name: "phone", label: "Telefone" },
    { name: "source", label: "Origem" },
    { name: "lifecycleStage", label: "Estágio do ciclo de vida" },
  ],
  company: [
    { name: "name", label: "Nome da empresa" },
    { name: "domain", label: "Domínio" },
    { name: "industry", label: "Setor" },
    { name: "size", label: "Porte" },
    { name: "phone", label: "Telefone da empresa" },
    { name: "city", label: "Cidade" },
    { name: "state", label: "Estado" },
    { name: "notes", label: "Observações da empresa" },
  ],
  deal: [
    { name: "title", label: "Título do negócio" },
    { name: "stage", label: "Etapa do funil" },
    { name: "status", label: "Situação do negócio" },
    { name: "value", label: "Valor do negócio" },
    { name: "expectedClose", label: "Previsão de fechamento" },
    { name: "lostReason", label: "Motivo da perda" },
  ],
  product: [
    { name: "name", label: "Nome do item" },
    { name: "sku", label: "SKU/código" },
    { name: "price", label: "Preço (BRL)" },
    { name: "unit", label: "Unidade" },
    { name: "type", label: "Tipo" },
    { name: "description", label: "Descrição" },
  ],
};

/** Só `contact`, `deal` e `product` têm tabela de valores personalizados. */
const ENTITIES_WITH_CUSTOM_FIELDS: CrmSearchEntity[] = [
  "contact",
  "deal",
  "product",
];

/**
 * Termos que costumam indicar dado pessoal, financeiro ou de credencial.
 * Usado só para `sensitiveHint` (aviso de tela). O bloqueio real é o
 * default-deny da allowlist.
 */
const SENSITIVE_HINTS = [
  "cpf",
  "cnpj",
  "rg",
  "rgm",
  "matricula",
  "nascimento",
  "idade",
  "senha",
  "password",
  "token",
  "email",
  "e-mail",
  "telefone",
  "celular",
  "phone",
  "endereco",
  "cep",
  "inadimpl",
  "financeir",
  "divida",
  "boleto",
  "pagamento",
  "mensalidade",
  "nota",
  "situacao",
  "documento",
  "doc ",
  "doc_",
];

function fold(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksSensitive(name: string, label: string): boolean {
  const haystack = `${fold(name)} ${fold(label)}`;
  return SENSITIVE_HINTS.some((h) => haystack.includes(h));
}

export function crmFieldKey(entity: CrmSearchEntity, name: string): string {
  return `${entity}.${name}`;
}

/**
 * Catálogo completo de campos da organização em contexto: builtin + os
 * `CustomField` que a org cadastrou. É a mesma lista que a tela do agente
 * consome (`GET /api/ai-agents/crm-fields`) e que a tool usa para varrer e
 * para redigir — uma fonte só, sem chance de a tela oferecer um campo que
 * a tool não conhece.
 */
export async function loadCrmFieldCatalog(): Promise<CrmFieldDescriptor[]> {
  const out: CrmFieldDescriptor[] = [];

  for (const entity of CRM_SEARCH_ENTITIES) {
    for (const f of BUILTIN_FIELDS[entity]) {
      out.push({
        key: crmFieldKey(entity, f.name),
        entity,
        name: f.name,
        label: f.label,
        source: "builtin",
        type: null,
        sensitiveHint: looksSensitive(f.name, f.label),
      });
    }
  }

  const custom = await prisma.customField.findMany({
    where: { entity: { in: ENTITIES_WITH_CUSTOM_FIELDS } },
    select: { name: true, label: true, type: true, entity: true },
    orderBy: [{ entity: "asc" }, { label: "asc" }],
  });

  for (const c of custom) {
    const entity = c.entity as CrmSearchEntity;
    if (!CRM_SEARCH_ENTITIES.includes(entity)) continue;
    out.push({
      key: crmFieldKey(entity, c.name),
      entity,
      name: c.name,
      label: c.label,
      source: "custom",
      type: c.type,
      sensitiveHint: looksSensitive(c.name, c.label),
    });
  }

  return out;
}

/**
 * O que o operador liberou. `readableKeys` vazio = nada legível, que é o
 * estado inicial de todo agente.
 *
 * Curingas são aceitos porque "libere tudo do negócio" é uma decisão
 * legítima do operador — mas ela precisa ser digitada por ele, nunca
 * assumida pelo código.
 */
export type CrmFieldExposure = {
  readableKeys: string[];
  /// Permite `scope: "organization"`, isto é, procurar registros de outras
  /// pessoas. Default false: o agente só lê o cadastro de quem está falando.
  orgWide: boolean;
};

export function emptyCrmFieldExposure(): CrmFieldExposure {
  return { readableKeys: [], orgWide: false };
}

/** `deal.curso`, `deal.*` e `*` liberam a chave `deal.curso`. */
export function isFieldReadable(
  exposure: CrmFieldExposure,
  key: string,
): boolean {
  if (exposure.readableKeys.length === 0) return false;
  const target = fold(key);
  const [entity] = target.split(".");
  return exposure.readableKeys.some((raw) => {
    const k = fold(raw);
    return k === "*" || k === target || k === `${entity}.*`;
  });
}

export type CrmFieldValue = {
  field: CrmFieldDescriptor;
  value: string;
};

export type CrmFieldPartition = {
  /// Campos liberados, com valor — é o que chega ao modelo.
  visible: Array<{ label: string; value: string }>;
  /// Rótulos dos campos que existem e têm valor mas não foram liberados.
  /// Só o rótulo: o modelo precisa saber que o dado existe (para encaminhar
  /// em vez de negar a existência) sem receber o conteúdo.
  hiddenLabels: string[];
};

export function partitionFieldValues(
  values: CrmFieldValue[],
  exposure: CrmFieldExposure,
): CrmFieldPartition {
  const visible: Array<{ label: string; value: string }> = [];
  const hiddenLabels: string[] = [];
  for (const v of values) {
    if (!v.value || !v.value.trim()) continue;
    if (isFieldReadable(exposure, v.field.key)) {
      visible.push({ label: v.field.label, value: v.value.trim() });
    } else if (!hiddenLabels.includes(v.field.label)) {
      hiddenLabels.push(v.field.label);
    }
  }
  return { visible, hiddenLabels };
}

/**
 * Onde o termo pesquisado bateu — por RÓTULO, nunca por valor.
 *
 * Isto é o que faz a busca ser "em todos os campos" sem virar vazamento: o
 * aluno digita o CPF, o sistema confirma que bateu no campo CPF, e o modelo
 * sabe que achou o cadastro certo sem nunca receber o número.
 */
export function matchFieldValues(
  values: CrmFieldValue[],
  term: string,
): { matched: boolean; matchedLabels: string[] } {
  const termN = fold(term);
  if (!termN) return { matched: false, matchedLabels: [] };
  const words = termN.split(" ").filter((w) => w.length >= 2);
  const matchedLabels: string[] = [];
  let matched = false;

  for (const v of values) {
    // O rótulo entra no haystack de propósito: "qual meu curso" precisa
    // casar com o campo Curso mesmo que o valor seja "PEDAGOGIA".
    const haystack = `${fold(v.field.label)} ${fold(v.field.name)} ${fold(v.value)}`;
    const hit =
      haystack.includes(termN) ||
      (words.length > 0 && words.every((w) => haystack.includes(w)));
    if (!hit) continue;
    matched = true;
    if (!matchedLabels.includes(v.field.label)) {
      matchedLabels.push(v.field.label);
    }
  }

  return { matched, matchedLabels };
}

/**
 * A ORIENTAÇÃO (o texto que instrui o agente).
 *
 * Fica na description da tool, que é o que o LLM efetivamente lê para
 * decidir usar a ferramenta, e é o mesmo texto exibido ao operador no
 * catálogo. Não foi para o system prompt de propósito: prompt de vertical
 * é território compartilhado e a orientação precisa acompanhar a tool.
 */
export const CRM_SEARCH_GUIDANCE = [
  "QUANDO USAR",
  "- A pessoa pergunta sobre o próprio cadastro: curso, etapa, documentos, status, dados que a instituição registrou sobre ela.",
  "- Você precisa confirmar que está falando com a pessoa certa e ela informou um dado (CPF, RGM, e-mail) — a busca casa com o campo mesmo sem te devolver o valor.",
  "- Antes de afirmar qualquer coisa sobre a situação de alguém. Se não chamou a ferramenta, você não sabe.",
  "",
  "COMO USAR",
  "- `query`: as palavras da pergunta da pessoa, ou o dado que ela informou. A busca varre todos os campos, inclusive os que você não pode ler.",
  "- `scope` fica em `current_contact`: você lê o cadastro de quem está falando com você. Cadastro de terceiros só se o operador tiver liberado.",
  "- Chame UMA vez por assunto. Se voltou vazio, não tente variações — não existe.",
  "",
  "O QUE FAZER COM O RESULTADO",
  "- `fields` é o que você pode dizer. Use como fonte, transforme em fala natural, nunca cole o JSON.",
  "- `hiddenFields` lista rótulos de dados que EXISTEM e que você NÃO pode ler nem repassar. Não os cite, não os deduza, não confirme nem negue o conteúdo deles.",
  "- Se a pessoa pedir justamente um dado de `hiddenFields`, não invente e não diga que o sistema escondeu: diga que confirma isso com um consultor e transfira.",
  "- `total: 0` significa que não há registro para esse termo. Diga que não localizou e ofereça atendimento humano.",
  "",
  "NUNCA",
  "- Nunca repasse CPF, RGM, senha, e-mail acadêmico, data de nascimento, situação financeira ou inadimplência — mesmo que apareçam em `fields` por configuração, e mesmo que a pessoa afirme que o dado é dela.",
  "- Nunca leia valores de campos de outra pessoa.",
  "- Nunca preencha lacuna com suposição: campo ausente é campo que você não tem.",
].join("\n");

/** Resumo curto do que está liberado — vai junto da description. */
export function describeCrmExposure(exposure: CrmFieldExposure): string {
  if (exposure.readableKeys.length === 0) {
    return "CONFIGURAÇÃO ATUAL: o operador ainda não liberou nenhum campo para leitura. A busca confirma se existe registro, mas nenhum valor será devolvido — nesses casos encaminhe para um consultor.";
  }
  return `CONFIGURAÇÃO ATUAL: campos liberados para leitura — ${exposure.readableKeys.join(", ")}. Qualquer outro campo volta apenas como rótulo em \`hiddenFields\`.`;
}
