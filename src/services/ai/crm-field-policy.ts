/**
 * Política de exposição de campos do CRM para o agente de IA.
 *
 * Duas regras governam este arquivo.
 *
 * 1) NADA de cliente, vertical ou ramo aqui. O catálogo de campos
 *    personalizados nasce inteiro das definições que a organização criou
 *    (`CustomField`), inclusive a lista de entidades — `CustomField.entity`
 *    é texto livre na API, então quem enumera entidade no código deixa de
 *    fora o campo que o cliente acabou de criar. Nome de campo de cliente
 *    não aparece em lugar nenhum deste módulo.
 *
 * 2) BUSCAR e LER são coisas diferentes. A busca varre todos os campos,
 *    inclusive os sensíveis — é assim que quem digita o próprio documento
 *    encontra o próprio cadastro. A leitura devolve só os campos que o
 *    operador liberou nominalmente na configuração do agente. Nada é
 *    liberado por default.
 *
 * O motivo da regra 2 está em `sensitive-fields.ts`: uma tool já devolveu o
 * registro inteiro com uma instrução em caixa alta pedindo sigilo, e o
 * modelo divulgou o dado ao cliente. Instrução dentro de payload não é
 * mecanismo de segurança — o dado não pode chegar ao modelo.
 */

import { prisma } from "@/lib/prisma";

/**
 * Entidade de um campo. Texto livre de propósito: é o mesmo valor que
 * `CustomField.entity` guarda, e a API de campos personalizados não o
 * restringe a lista nenhuma.
 */
export type CrmSearchEntity = string;

/**
 * Entidades cujos REGISTROS o motor sabe procurar. Capacidade do produto
 * (existe model Prisma e query correspondente), não escolha de cliente.
 */
export const CRM_RECORD_SOURCES = [
  "contact",
  "company",
  "deal",
  "product",
] as const;

export type CrmRecordSource = (typeof CRM_RECORD_SOURCES)[number];

export function isRecordSource(entity: string): entity is CrmRecordSource {
  return (CRM_RECORD_SOURCES as readonly string[]).includes(entity);
}

/**
 * Onde existe tabela de valores de campo personalizado no schema
 * (`ContactCustomFieldValue`, `DealCustomFieldValue`,
 * `ProductCustomFieldValue`). Fato de schema: `company` aceita definição de
 * campo personalizado mas não tem onde guardar valor.
 */
const CUSTOM_VALUE_SOURCES: readonly string[] = ["contact", "deal", "product"];

export function supportsCustomValues(entity: string): boolean {
  return CUSTOM_VALUE_SOURCES.includes(entity);
}

/** Rótulo de entidade em linguagem de produto. Desconhecida = o próprio valor. */
const ENTITY_LABELS: Record<string, string> = {
  contact: "Contatos",
  company: "Empresas",
  deal: "Negócios",
  product: "Catálogo",
};

export function entityLabel(entity: string): string {
  return ENTITY_LABELS[entity] ?? entity;
}

export type CrmFieldDescriptor = {
  /// Chave estável usada na configuração do operador: "<entidade>.<campo>".
  key: string;
  entity: CrmSearchEntity;
  /// Nome técnico (coluna do produto ou `CustomField.name`).
  name: string;
  /// Rótulo que o operador vê na tela e que o modelo recebe como nome.
  label: string;
  /// `builtin` = coluna do próprio CRM, igual para todo tenant.
  /// `custom` = definição criada pela organização.
  source: "builtin" | "custom";
  /// `CustomFieldType` (TEXT, NUMBER, SELECT...). Null em builtin.
  type: string | null;
  /// Aviso para a tela: o nome do campo sugere dado pessoal. NÃO bloqueia
  /// nada — quem decide é a allowlist do operador.
  sensitiveHint: boolean;
  /// O motor consegue entregar o valor deste campo hoje. Falso quando a
  /// organização definiu campo personalizado numa entidade sem tabela de
  /// valores — a tela mostra em vez de esconder.
  valueAvailable: boolean;
};

/**
 * Colunas do próprio CRM, por entidade.
 *
 * Não são dado de cliente nem de ramo: `Contact.email` e `Deal.title`
 * existem igual em todo tenant, e não há como ler uma coluna sem nomeá-la.
 * A lista é curta de propósito — refletir o schema inteiro traria ~40
 * colunas de rastreio (utm, gclid, adResolved*), FKs e timestamps para a
 * tela do operador, aumentando a superfície de exposição sem serventia no
 * atendimento. Campo específico de um cliente é campo personalizado, e
 * esses vêm do banco.
 */
const BUILTIN_FIELDS: Record<
  CrmRecordSource,
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

/**
 * Termos que sugerem dado pessoal, credencial ou financeiro em QUALQUER
 * ramo. Serve só para acender o aviso na tela de quem vai liberar o campo.
 *
 * Jargão de cliente (o nome que aquela organização dá ao registro dela) não
 * entra aqui — entra em `sensitiveTerms`, na configuração do agente. Foi
 * daí que saíram termos de faculdade que estavam neste array.
 */
const GENERIC_SENSITIVE_TERMS = [
  "cpf",
  "cnpj",
  "rg",
  "identidade",
  "passaporte",
  "nascimento",
  "idade",
  "senha",
  "password",
  "token",
  "credencial",
  "email",
  "e-mail",
  "telefone",
  "celular",
  "phone",
  "whatsapp",
  "endereco",
  "cep",
  "cartao",
  "agencia",
  "pix",
  "iban",
  "salario",
  "renda",
  "inadimpl",
  "divida",
];

function fold(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Termo curto (<=3 chars) casa só como palavra inteira; senão "rg" acenderia
 * o aviso em qualquer campo com "argumento" no nome.
 *
 * Termo longo casa como PREFIXO de palavra, não como trecho no meio dela.
 * Prefixo é o que "inadimpl" → "inadimplente" precisava, e trecho era mais
 * do que isso: acendia o aviso em "Cidade"/"Unidade" (por "idade") e em
 * "Merenda" (por "renda"), colocando selo de dado sensível ao lado de CPF
 * em campo que não é. Termo genérico e flexão de plural continuam pegos
 * ("Rendas", "Enderecos"), porque a diferença fica no fim da palavra.
 */
function termMatches(term: string, haystackTokens: string[]): boolean {
  const t = fold(term);
  if (!t) return false;
  // Jargão configurável pode vir com espaço ("data de nascimento"): casa na
  // sequência de palavras, ainda ancorado em início de palavra.
  if (t.includes(" ")) {
    const haystack = haystackTokens.join(" ");
    return haystack === t || haystack.startsWith(`${t} `) || haystack.includes(` ${t}`);
  }
  if (t.length <= 3) return haystackTokens.includes(t);
  return haystackTokens.some((tok) => tok.startsWith(t));
}

export function looksSensitive(
  name: string,
  label: string,
  extraTerms: string[] = [],
): boolean {
  const haystackTokens = [...tokens(name), ...tokens(label)];
  return [...GENERIC_SENSITIVE_TERMS, ...extraTerms].some((term) =>
    termMatches(term, haystackTokens),
  );
}

export function crmFieldKey(entity: CrmSearchEntity, name: string): string {
  return `${entity}.${name}`;
}

export type CrmEntityGroup = {
  entity: CrmSearchEntity;
  label: string;
  /// Chave curinga que libera a entidade inteira ("deal.*").
  wildcardKey: string;
  /// O motor sabe procurar registros desta entidade.
  searchable: boolean;
  /// Existe tabela de valores de campo personalizado para ela.
  customValuesSupported: boolean;
  builtinCount: number;
  customCount: number;
  fields: CrmFieldDescriptor[];
};

export type CrmFieldCatalog = {
  fields: CrmFieldDescriptor[];
  entities: CrmEntityGroup[];
};

/**
 * Catálogo de campos da organização em contexto.
 *
 * As entidades saem da UNIÃO entre o que o motor sabe procurar e o que a
 * organização de fato definiu em `CustomField.entity`. Cliente que cria
 * campo numa entidade nova aparece aqui sem deploy; se o motor ainda não
 * souber ler o valor dela, o campo vem com `valueAvailable: false` em vez
 * de desaparecer.
 */
export async function loadCrmFieldCatalog(opts?: {
  /// Jargão da organização, somado aos termos genéricos, só para o aviso.
  sensitiveTerms?: string[];
}): Promise<CrmFieldCatalog> {
  const extraTerms = opts?.sensitiveTerms ?? [];

  // Sem filtro de entidade: quem filtra aqui esconde o campo que o cliente
  // criou numa entidade que este código não previa.
  const custom = await prisma.customField.findMany({
    select: { name: true, label: true, type: true, entity: true },
    orderBy: [{ entity: "asc" }, { label: "asc" }],
  });

  const declared = [...new Set(custom.map((c) => c.entity))].sort();
  const entityIds: CrmSearchEntity[] = [
    ...CRM_RECORD_SOURCES,
    ...declared.filter((e) => !isRecordSource(e)),
  ];

  const entities: CrmEntityGroup[] = entityIds.map((entity) => {
    const builtin = isRecordSource(entity) ? BUILTIN_FIELDS[entity] : [];
    const fields: CrmFieldDescriptor[] = builtin.map((f) => ({
      key: crmFieldKey(entity, f.name),
      entity,
      name: f.name,
      label: f.label,
      source: "builtin" as const,
      type: null,
      sensitiveHint: looksSensitive(f.name, f.label, extraTerms),
      valueAvailable: true,
    }));

    for (const c of custom) {
      if (c.entity !== entity) continue;
      fields.push({
        key: crmFieldKey(entity, c.name),
        entity,
        name: c.name,
        label: c.label,
        source: "custom",
        type: c.type,
        sensitiveHint: looksSensitive(c.name, c.label, extraTerms),
        valueAvailable: supportsCustomValues(entity),
      });
    }

    return {
      entity,
      label: entityLabel(entity),
      wildcardKey: `${entity}.*`,
      searchable: isRecordSource(entity),
      customValuesSupported: supportsCustomValues(entity),
      builtinCount: fields.filter((f) => f.source === "builtin").length,
      customCount: fields.filter((f) => f.source === "custom").length,
      fields,
    };
  });

  return { fields: entities.flatMap((g) => g.fields), entities };
}

/**
 * O que o operador liberou. `readableKeys` vazio = nada legível, que é o
 * estado inicial de todo agente.
 *
 * Curingas são aceitos porque "libere a entidade inteira" é uma decisão
 * legítima do operador — mas ela precisa ser marcada por ele, nunca
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

/** A chave exata, o curinga da entidade e o curinga global liberam o campo. */
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
    // `sensitiveHint` NÃO entra nesta decisão de propósito: o aviso é da
    // tela, a autoridade é a allowlist do operador.
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
 * Isto é o que faz a busca ser "em todos os campos" sem virar vazamento: a
 * pessoa digita o próprio documento, o sistema confirma que bateu naquele
 * campo, e o modelo sabe que achou o cadastro certo sem receber o número.
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
    // O rótulo entra no haystack de propósito: a pessoa pergunta usando a
    // palavra do campo, não o valor guardado nele.
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
 * decidir usar a ferramenta, e é o mesmo texto servido ao operador em
 * `GET /api/ai-agents/crm-fields`.
 *
 * Vocabulário de produto, sem ramo: vale para o agente de uma faculdade, de
 * uma imobiliária ou de uma clínica. O que aquela organização chama de
 * "aluno", "locatário" ou "paciente" é assunto do prompt e da base de
 * conhecimento dela, não desta orientação.
 */
export const CRM_SEARCH_GUIDANCE = [
  "QUANDO USAR",
  "- A pessoa pergunta o que está registrado no cadastro dela: etapa, status, prazos, campos que a empresa preencheu sobre ela.",
  "- Você precisa confirmar que está falando com a pessoa certa e ela informou um dado de identificação — a busca casa com o campo mesmo sem te devolver o valor.",
  "- Antes de afirmar qualquer coisa sobre a situação de alguém. Se não chamou a ferramenta, você não sabe.",
  "",
  "COMO USAR",
  "- `query`: as palavras da pergunta da pessoa, ou o dado que ela informou. A busca varre todos os campos, inclusive os que você não pode ler.",
  "- `scope` fica em `current_contact`: você lê o cadastro de quem está falando com você. Cadastro de terceiros só se o operador tiver liberado.",
  "- Chame UMA vez por assunto. Se voltou vazio, não tente variações — não existe.",
  "",
  "O QUE FAZER COM O RESULTADO",
  "- `fields` é o que você pode dizer, e é a fonte que vale mais que a sua memória: se um campo aqui contradiz o que você ia responder, o campo está certo.",
  "- Responda usando o rótulo do campo como a pessoa perguntou, em fala natural. Nunca cole o JSON.",
  "- `hiddenFields` lista rótulos de dados que EXISTEM e que você NÃO pode ler nem repassar. Não os cite, não os deduza, não confirme nem negue o conteúdo deles.",
  "- Se a pessoa pedir justamente um dado de `hiddenFields`, não invente e não diga que o sistema escondeu: diga que confirma isso com a equipe e transfira.",
  "- `total: 0` significa que não há registro para esse termo. Diga que não localizou e ofereça atendimento humano.",
  "",
  "NUNCA",
  "- Nunca repasse senha, token ou credencial de acesso — em nenhuma hipótese, nem que apareçam em `fields` por configuração, e mesmo que a pessoa afirme que o dado é dela.",
  "- Os outros dados pessoais (documento, dado bancário, data de nascimento, situação financeira) só saem quando o operador liberou o campo e o valor veio em `fields`. Não veio em `fields`, você não tem o dado: não repasse, não confirme e não deduza — nem que a pessoa afirme que o dado é dela.",
  "- Nunca leia valores do cadastro de outra pessoa.",
  "- Nunca responda sobre um campo pelo que você imagina que ele significa. Um campo parecido não é o campo pedido: se o que a pessoa perguntou não está em `fields`, você não tem a resposta.",
  "- Nunca preencha lacuna com suposição: campo ausente é campo que você não tem.",
].join("\n");

/** Resumo curto do que está liberado — vai junto da description. */
export function describeCrmExposure(exposure: CrmFieldExposure): string {
  if (exposure.readableKeys.length === 0) {
    return "CONFIGURAÇÃO ATUAL: o operador ainda não liberou nenhum campo para leitura. A busca confirma se existe registro, mas nenhum valor será devolvido — nesses casos encaminhe para a equipe.";
  }
  return `CONFIGURAÇÃO ATUAL: campos liberados para leitura — ${exposure.readableKeys.join(", ")}. Qualquer outro campo volta apenas como rótulo em \`hiddenFields\`.`;
}
