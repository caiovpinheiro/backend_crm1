/**
 * Registro de FONTES consultáveis pelo motor de agentes.
 *
 * O motor não conhece conceito de negócio nenhum — nem o nome que cada
 * cliente dá ao registro dele. Ele sabe três coisas: quais fontes existem,
 * quais campos cada uma expõe e
 * como executar três operações sobre elas — trazer o que está ligado ao
 * contato da conversa, casar um valor exato num campo e varrer por um
 * termo. Tudo o mais (rótulo, vocabulário, qual campo identifica quem) é
 * configuração do tenant.
 *
 * Quatro fontes nascem aqui porque são models do próprio CRM e existem em
 * qualquer organização. Uma fonte de produto (relatório importado, base
 * legada, tabela de um vertical) entra pelo pack, em
 * `VerticalPack.recordSources` — nunca por um `if` neste arquivo.
 */

import { prisma } from "@/lib/prisma";

/** Coluna própria da fonte. Campo personalizado vem do banco, não daqui. */
export type RecordSourceField = {
  name: string;
  label: string;
  /**
   * `false` = serve para ACHAR o registro e nunca para ser dito. Não existe
   * configuração que libere: é o veto estrutural que documento e credencial
   * de identificação têm. A allowlist do operador governa o resto.
   */
  readable?: boolean;
};

/** Registro cru devolvido por uma fonte, antes de qualquer política. */
export type RawRecord = {
  /// Id do registro na fonte. Usado para fixar a identidade da conversa.
  id: string;
  /// Referência curta que o modelo pode repetir ("negócio #37514").
  /// NUNCA carregue aqui valor de campo — isto passa por fora da allowlist.
  ref: string;
  /// Valores das colunas próprias da fonte, por `RecordSourceField.name`.
  builtin: Record<string, unknown>;
  /// Valores de campo personalizado, por `CustomField.name`.
  custom: Array<{ name: string; value: string }>;
};

/** O que a fonte recebe para responder. Escopo de org resolvido pelo motor. */
export type RecordQuery = {
  organizationId: string;
  /// Quem está na conversa. `null` em busca ampla.
  contact: {
    id: string;
    phone?: string | null;
    email?: string | null;
  } | null;
  take: number;
};

export type RecordSource = {
  /// Id estável, prefixo das chaves de configuração ("deal.titulo").
  entity: string;
  /// Rótulo em linguagem de operador.
  label: string;
  fields: RecordSourceField[];
  /// Existe tabela de valores de campo personalizado para esta entidade.
  supportsCustomValues: boolean;
  /**
   * Um registro desta fonte pertence a UMA pessoa, então faz sentido alguém
   * provar quem é informando um valor dele. Falso em empresa e catálogo:
   * ali o dado é de terceiro, e aceitar seria abrir cadastro alheio.
   */
  identifiesPerson: boolean;
  /**
   * Um contato pode ter VÁRIOS registros aqui. É o que liga o desempate por
   * campo-chave e a fixação da identidade na conversa: com um registro só
   * por contato, perguntar "qual deles?" seria ruído.
   */
  multiplePerContact: boolean;
  /**
   * Os registros não pertencem a ninguém (catálogo, tabela de preços). A
   * busca é sempre ampla, independente do escopo — e nunca "do contato".
   */
  sharedCatalog: boolean;
  /// Registros ligados ao contato da conversa (identificação passiva).
  forContact: (q: RecordQuery) => Promise<RawRecord[]>;
  /// Casamento EXATO num campo. `candidates` já vem normalizado e cru.
  findByFieldValue: (
    q: RecordQuery & {
      field: { name: string; source: "builtin" | "custom" };
      candidates: string[];
    },
  ) => Promise<RawRecord[]>;
  /// Varredura por termo livre, escopo da organização inteira.
  searchByTerm: (q: RecordQuery & { term: string }) => Promise<RawRecord[]>;
};

/** `{ nome: valor }` a partir das linhas de campo personalizado do Prisma. */
function customOf(
  rows: Array<{ value: string; customField: { name: string } }>,
): Array<{ name: string; value: string }> {
  return rows.map((r) => ({ name: r.customField.name, value: r.value }));
}

const CUSTOM_INCLUDE = {
  include: { customField: { select: { name: true } } },
} as const;

/**
 * `where` de casamento exato. Campo personalizado entra pela tabela de
 * valores; coluna própria, pela própria coluna. `contains` não aparece aqui
 * de propósito: identificador que é trecho de outro abriria o registro
 * errado.
 */
function equalsWhere(
  field: { name: string; source: "builtin" | "custom" },
  candidates: string[],
): Record<string, unknown> {
  if (field.source === "custom") {
    return {
      customFields: {
        some: {
          customField: { name: field.name },
          value: { in: candidates, mode: "insensitive" as const },
        },
      },
    };
  }
  return { [field.name]: { in: candidates, mode: "insensitive" as const } };
}

// ── Contato ────────────────────────────────────────────────────

const contactSource: RecordSource = {
  entity: "contact",
  label: "Contatos",
  supportsCustomValues: true,
  identifiesPerson: true,
  multiplePerContact: false,
  sharedCatalog: false,
  fields: [
    { name: "name", label: "Nome" },
    { name: "email", label: "E-mail" },
    { name: "phone", label: "Telefone" },
    { name: "source", label: "Origem" },
    { name: "lifecycleStage", label: "Estágio do ciclo de vida" },
  ],
  forContact: async (q) => {
    if (!q.contact) return [];
    const c = await prisma.contact.findUnique({
      where: { id: q.contact.id },
      include: { customFields: CUSTOM_INCLUDE },
    });
    return c ? [contactRecord(c)] : [];
  },
  findByFieldValue: async (q) => {
    const rows = await prisma.contact.findMany({
      where: equalsWhere(q.field, q.candidates),
      take: q.take,
      include: { customFields: CUSTOM_INCLUDE },
    });
    return rows.map(contactRecord);
  },
  searchByTerm: async (q) => {
    const rows = await prisma.contact.findMany({
      where: {
        OR: [
          { name: { contains: q.term, mode: "insensitive" } },
          { email: { contains: q.term, mode: "insensitive" } },
          { phone: { contains: q.term } },
          {
            customFields: {
              some: { value: { contains: q.term, mode: "insensitive" } },
            },
          },
        ],
      },
      take: q.take,
      include: { customFields: CUSTOM_INCLUDE },
    });
    return rows.map(contactRecord);
  },
};

function contactRecord(c: {
  id: string;
  number: number;
  customFields: Array<{ value: string; customField: { name: string } }>;
}): RawRecord {
  return {
    id: c.id,
    ref: `contato #${c.number}`,
    builtin: c as unknown as Record<string, unknown>,
    custom: customOf(c.customFields),
  };
}

// ── Empresa ────────────────────────────────────────────────────

const companySource: RecordSource = {
  entity: "company",
  label: "Empresas",
  // Fato de schema: o CRM aceita DEFINIR campo personalizado de empresa mas
  // não tem tabela onde guardar o valor.
  supportsCustomValues: false,
  identifiesPerson: false,
  multiplePerContact: false,
  sharedCatalog: false,
  fields: [
    { name: "name", label: "Nome da empresa" },
    { name: "domain", label: "Domínio" },
    { name: "industry", label: "Setor" },
    { name: "size", label: "Porte" },
    { name: "phone", label: "Telefone da empresa" },
    { name: "city", label: "Cidade" },
    { name: "state", label: "Estado" },
    { name: "notes", label: "Observações da empresa" },
  ],
  forContact: async (q) => {
    if (!q.contact) return [];
    const c = await prisma.contact.findUnique({
      where: { id: q.contact.id },
      select: { company: true },
    });
    return c?.company ? [companyRecord(c.company)] : [];
  },
  findByFieldValue: async (q) => {
    if (q.field.source === "custom") return [];
    const rows = await prisma.company.findMany({
      where: equalsWhere(q.field, q.candidates),
      take: q.take,
    });
    return rows.map(companyRecord);
  },
  searchByTerm: async (q) => {
    const rows = await prisma.company.findMany({
      where: {
        OR: [
          { name: { contains: q.term, mode: "insensitive" } },
          { domain: { contains: q.term, mode: "insensitive" } },
          { city: { contains: q.term, mode: "insensitive" } },
        ],
      },
      take: q.take,
    });
    return rows.map(companyRecord);
  },
};

function companyRecord(co: { id: string; number: number }): RawRecord {
  return {
    id: co.id,
    ref: `empresa #${co.number}`,
    builtin: co as unknown as Record<string, unknown>,
    custom: [],
  };
}

// ── Negócio ────────────────────────────────────────────────────

const DEAL_INCLUDE = {
  stage: { select: { name: true } },
  customFields: CUSTOM_INCLUDE,
} as const;

const dealSource: RecordSource = {
  entity: "deal",
  label: "Negócios",
  supportsCustomValues: true,
  identifiesPerson: true,
  multiplePerContact: true,
  sharedCatalog: false,
  fields: [
    { name: "title", label: "Título do negócio" },
    { name: "stage", label: "Etapa do funil" },
    { name: "status", label: "Situação do negócio" },
    { name: "value", label: "Valor do negócio" },
    { name: "expectedClose", label: "Previsão de fechamento" },
    { name: "lostReason", label: "Motivo da perda" },
  ],
  forContact: async (q) => {
    if (!q.contact) return [];
    const rows = await prisma.deal.findMany({
      where: { contactId: q.contact.id },
      orderBy: [{ updatedAt: "desc" }],
      take: q.take,
      include: DEAL_INCLUDE,
    });
    return rows.map(dealRecord);
  },
  findByFieldValue: async (q) => {
    const rows = await prisma.deal.findMany({
      where: equalsWhere(q.field, q.candidates),
      take: q.take,
      orderBy: [{ updatedAt: "desc" }],
      include: DEAL_INCLUDE,
    });
    return rows.map(dealRecord);
  },
  searchByTerm: async (q) => {
    const rows = await prisma.deal.findMany({
      where: {
        OR: [
          { title: { contains: q.term, mode: "insensitive" } },
          {
            customFields: {
              some: { value: { contains: q.term, mode: "insensitive" } },
            },
          },
        ],
      },
      take: q.take,
      include: DEAL_INCLUDE,
    });
    return rows.map(dealRecord);
  },
};

function dealRecord(d: {
  id: string;
  number: number;
  value: unknown;
  stage?: { name: string } | null;
  customFields: Array<{ value: string; customField: { name: string } }>;
}): RawRecord {
  return {
    id: d.id,
    ref: `negócio #${d.number}`,
    builtin: { ...d, stage: d.stage?.name ?? null, value: Number(d.value) },
    custom: customOf(d.customFields),
  };
}

// ── Catálogo ───────────────────────────────────────────────────

const productSource: RecordSource = {
  entity: "product",
  label: "Catálogo",
  supportsCustomValues: true,
  identifiesPerson: false,
  multiplePerContact: false,
  sharedCatalog: true,
  fields: [
    { name: "name", label: "Nome do item" },
    { name: "sku", label: "SKU/código" },
    { name: "price", label: "Preço (BRL)" },
    { name: "unit", label: "Unidade" },
    { name: "type", label: "Tipo" },
    { name: "description", label: "Descrição" },
  ],
  // O catálogo não é cadastro de pessoa: não há "item do contato".
  forContact: async () => [],
  findByFieldValue: async () => [],
  searchByTerm: async (q) => {
    const rows = await prisma.product.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q.term, mode: "insensitive" } },
          { sku: { contains: q.term, mode: "insensitive" } },
          { description: { contains: q.term, mode: "insensitive" } },
          {
            customValues: {
              some: { value: { contains: q.term, mode: "insensitive" } },
            },
          },
        ],
      },
      take: q.take,
      include: { customValues: CUSTOM_INCLUDE },
    });
    return rows.map((p) => ({
      id: p.id,
      ref: `item #${p.number}`,
      builtin: { ...p, price: Number(p.price) },
      custom: customOf(p.customValues),
    }));
  },
};

/**
 * Fontes do produto. Existem em qualquer organização porque são models do
 * próprio CRM — não são escolha de cliente nem de ramo.
 */
export const CORE_RECORD_SOURCES: RecordSource[] = [
  contactSource,
  companySource,
  dealSource,
  productSource,
];

/**
 * Fontes visíveis para um tenant: as do produto mais as que o pack dele
 * registrou. O núcleo descobre por aqui; não conhece nenhuma pelo nome.
 */
export function listRecordSources(
  packSources?: RecordSource[] | null,
): RecordSource[] {
  if (!packSources?.length) return CORE_RECORD_SOURCES;
  const known = new Set(CORE_RECORD_SOURCES.map((s) => s.entity));
  return [
    ...CORE_RECORD_SOURCES,
    ...packSources.filter((s) => !known.has(s.entity)),
  ];
}

export function findRecordSource(
  sources: RecordSource[],
  entity: string,
): RecordSource | null {
  return sources.find((s) => s.entity === entity) ?? null;
}
