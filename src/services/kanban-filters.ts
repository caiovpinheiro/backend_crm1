/**
 * Filtros avançados do Kanban de deals.
 *
 * O cliente envia um objeto `AdvancedDealFilters` (livre, validado em
 * runtime) e o serviço traduz para `Prisma.DealWhereInput` somando ao
 * `where` base usado por `getBoardData` e listagens.
 *
 * Mantemos schema livre (JSON) na tabela `saved_filters` para evoluir
 * sem migration nova a cada operador.
 */

import type { DealStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getRequestContext } from "@/lib/request-context";

/**
 * Quando o termo de busca contém >=3 dígitos, casa o input contra o
 * telefone do contato **normalizado** (somente dígitos). Suporta o caso
 * comum: usuário digita "11945010493" mas telefone está salvo como
 * "+55 (11) 94501-0493" ou variações.
 */
/** Exposto para listagens (`getDeals`/`getContacts`) reutilizarem a mesma regra. */
export async function findContactIdsByPhoneDigits(
  digits: string,
): Promise<string[]> {
  if (digits.length < 3) return [];
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId;
  if (!orgId) return [];
  // Sufixo via reverse(...) LIKE 'rev%' — bate no índice
  // `contacts_org_phone_digits_rev_idx` (prefixo em btree).
  const suffix = digits.length > 11 ? digits.slice(-11) : digits;
  const revPrefix = [...suffix].reverse().join("") + "%";
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM contacts
    WHERE "organizationId" = ${orgId}
      AND reverse(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'))
          LIKE ${revPrefix}
    LIMIT 500
  `;
  return rows.map((r) => r.id);
}

/**
 * Teto de candidatos por pré-query de busca. Termos genéricos ("a", "silva")
 * casariam com dezenas de milhares de contatos — o IN gigante degradaria a
 * query de deals mais do que ajudaria. Com o teto, a busca fica "melhor
 * esforço" e o usuário refina o termo (padrão de CRMs: Kommo/Pipedrive).
 */
const SEARCH_CANDIDATE_CAP = 5000;

/**
 * Resolve os candidatos de busca em pré-queries indexadas (trgm GIN em
 * contacts.name/email/phone, ccfv.value, dcfv.value) e devolve IDs para o
 * filtro final de deals usar SÓ colunas da própria tabela (title ILIKE +
 * contactId/id IN). O planner consegue BitmapOr dos índices; o OR cross-table
 * anterior (self-joins em contacts + EXISTS aninhados por linha) seq-scaneava
 * deals — ~1s por COUNT no board e top-1 de CPU no pg_stat_statements.
 */
export async function resolveDealSearchCandidates(
  search: string,
): Promise<{ contactIds: string[]; dealIds: string[] }> {
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId;
  if (!orgId) return { contactIds: [], dealIds: [] };
  const pattern = `%${search}%`;
  const [byFields, byCcfv, byDcfv] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM contacts
      WHERE "organizationId" = ${orgId}
        AND (name ILIKE ${pattern} OR email ILIKE ${pattern} OR phone ILIKE ${pattern})
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
    prisma.$queryRaw<{ contactId: string }[]>`
      SELECT "contactId" FROM contact_custom_field_values
      WHERE "organizationId" = ${orgId} AND value ILIKE ${pattern}
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
    prisma.$queryRaw<{ dealId: string }[]>`
      SELECT "dealId" FROM deal_custom_field_values
      WHERE "organizationId" = ${orgId} AND value ILIKE ${pattern}
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
  ]);
  const contactIds = [
    ...new Set([...byFields.map((r) => r.id), ...byCcfv.map((r) => r.contactId)]),
  ];
  return { contactIds, dealIds: byDcfv.map((r) => r.dealId) };
}

/**
 * Casa uma busca só-dígitos contra valores de campos personalizados
 * **normalizados** (apenas dígitos). Cobre o caso do CPF/RGM salvo com
 * máscara ("123.456.789-00", "12.345.678") quando o operador digita só
 * números — e o inverso.
 *
 * Zeros à esquerda são descartados do termo porque a base tem CPF vindo do
 * ERP com o zero perdido ("1234567890" para 01234567890): com `%digits%` o
 * termo sem zero casa as duas formas.
 */
export async function findCustomFieldMatchesByDigits(digits: string): Promise<{
  dealIds: string[];
  contactIds: string[];
}> {
  const empty = { dealIds: [], contactIds: [] };
  const core = digits.replace(/^0+/, "");
  if (core.length < 6) return empty;
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) return empty;
  const pattern = `%${core}%`;
  const [dealRows, contactRows] = await Promise.all([
    // `'\\D'` (e não `'\D'`): em template literal o `\D` é cozido para `D` e o
    // regexp_replace passaria a remover a letra D, deixando a máscara intacta —
    // exatamente o que a normalização existe para evitar. O texto precisa bater
    // com a expressão do índice `*_cfv_value_digits_trgm_idx`.
    prisma.$queryRaw<{ dealId: string }[]>`
      SELECT DISTINCT "dealId" FROM deal_custom_field_values
      WHERE "organizationId" = ${orgId}
        AND regexp_replace(value, '\\D', '', 'g') LIKE ${pattern}
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
    prisma.$queryRaw<{ contactId: string }[]>`
      SELECT DISTINCT "contactId" FROM contact_custom_field_values
      WHERE "organizationId" = ${orgId}
        AND regexp_replace(value, '\\D', '', 'g') LIKE ${pattern}
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
  ]);
  return {
    dealIds: dealRows.map((r) => r.dealId),
    contactIds: contactRows.map((r) => r.contactId),
  };
}

/**
 * Monta o `OR` de busca livre de negócios — usado pelo Kanban (POST /board),
 * pela listagem (`getDeals`) e pela exportação, para que os três respondam
 * exatamente a mesma coisa.
 *
 * Campos cobertos: título, nome/e-mail/telefone do contato, número do negócio
 * e QUALQUER valor de campo personalizado do negócio ou do contato (CPF, RGM,
 * matrícula, polo, curso…). O filtro final toca só colunas de `deals`
 * (title ILIKE + contactId/id IN); o resto vem das pré-queries indexadas.
 */
export async function buildDealSearchOr(
  searchRaw: string,
): Promise<Prisma.DealWhereInput[]> {
  const search = searchRaw.trim();
  if (!search) return [];

  const digits = search.replace(/\D+/g, "");
  // Termo "numérico": CPF, RGM, matrícula, telefone ou número do negócio, com
  // ou sem máscara. O ILIKE literal de `resolveDealSearchCandidates` não casa
  // "123.456.789-00" com "12345678900" (nem o inverso), então para esses
  // termos usamos os lookups por dígitos normalizados. Procurar em nome/e-mail
  // é dispensável: não há CPF dentro de nome.
  const numericTerm =
    digits.replace(/^0+/, "").length >= 6 && /^[\d\s+().-]+$/.test(search);

  const or: Prisma.DealWhereInput[] = [
    { title: { contains: search, mode: "insensitive" } },
  ];
  const contactIdSet = new Set<string>();
  const dealIdSet = new Set<string>();

  if (numericTerm) {
    const [phoneContactIds, cfMatches] = await Promise.all([
      findContactIdsByPhoneDigits(digits),
      findCustomFieldMatchesByDigits(digits),
    ]);
    for (const id of phoneContactIds) contactIdSet.add(id);
    for (const id of cfMatches.contactIds) contactIdSet.add(id);
    for (const id of cfMatches.dealIds) dealIdSet.add(id);
  } else {
    const candidates = await resolveDealSearchCandidates(search);
    for (const id of candidates.contactIds) contactIdSet.add(id);
    for (const id of candidates.dealIds) dealIdSet.add(id);
    if (digits.length >= 3) {
      for (const id of await findContactIdsByPhoneDigits(digits)) {
        contactIdSet.add(id);
      }
    }
  }

  if (contactIdSet.size > 0) or.push({ contactId: { in: [...contactIdSet] } });
  if (dealIdSet.size > 0) or.push({ id: { in: [...dealIdSet] } });

  // Número do negócio ("#123" digitado sem o #). `Deal.number` é int4: termos
  // numéricos longos (CPF, RGM, telefone) estouram o limite e fazem o Postgres
  // abortar a query inteira — por isso o teto de int32.
  if (/^\d+$/.test(search)) {
    const asNumber = Number(search);
    if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 2147483647) {
      or.push({ number: asNumber });
    }
  }

  return or;
}

export type DateRangeValue = {
  from?: string | null;
  to?: string | null;
};

/** Sentinela usada no filtro de origem para "Sem origem" (espelha o dashboard). */
export const SOURCE_NONE = "__none__";

export type CustomFieldFilter = {
  /** Nome (slug) do CustomField — único por organizationId+entity. */
  name: string;
  /** Default: contains se value, filled caso contrário. */
  operator?:
    | "eq"
    | "neq"
    | "contains"
    | "not_contains"
    | "filled"
    | "empty"
    | "gt"
    | "lt"
    | "between"
    | "before"
    | "after"
    | "in";
  value?: string | string[] | DateRangeValue | null;
};

export type AdvancedDealFilters = {
  /** AND (todos) | OR (qualquer). Aplica-se à lista `customFilters` adicionais. */
  logic?: "AND" | "OR";

  search?: string;

  /** Pipeline (filtra pela stage.pipelineId). */
  pipelineId?: string;
  /** IDs de etapa (OR entre elas). */
  stageIds?: string[];
  /** Status do deal. */
  statuses?: DealStatus[];

  /** Responsáveis (deal.ownerId). Inclui "null" como "sem responsável". */
  ownerIds?: (string | null)[];
  /** true = só leads sem responsável. */
  withoutOwner?: boolean;
  /** true = só leads sem contato. */
  withoutContact?: boolean;

  /** Filtros por origem (Contact.source). Pode incluir `SOURCE_NONE`. */
  sources?: string[];
  /** true = só leads sem origem (contato ausente ou source null/""). */
  withoutSource?: boolean;

  /** Motivos de perda (Deal.lostReason) — match exato com a tabulação. */
  lostReasons?: string[];

  /** Tags do deal. */
  tagIds?: string[];
  /** any (qualquer) | all (todas) | none (sem nenhuma das informadas). */
  tagMode?: "any" | "all" | "none";
  /** true = só leads sem nenhuma tag (independente de `tagIds`). */
  withoutTags?: boolean;

  /** Filtros por contato. */
  contactSearch?: string;
  contactHasPhone?: boolean;
  contactHasEmail?: boolean;

  /** Datas: campo + intervalo. */
  createdAt?: DateRangeValue;
  updatedAt?: DateRangeValue;
  closedAt?: DateRangeValue;
  /** Último contato (última mensagem inbound ou outbound). */
  lastInteractionAt?: DateRangeValue;

  /** Campos personalizados de deal/contato. */
  dealCustomFields?: CustomFieldFilter[];
  contactCustomFields?: CustomFieldFilter[];

  /**
   * Filtros de conversa do contato (via Contact.conversations.some).
   * `conversationStatus`: "open" = alguma conversa não resolvida / "closed" = alguma resolvida.
   * `lastMessageDirection`: "out" = última msg nossa / "in" = última msg do cliente.
   */
  conversationStatus?: "open" | "closed";
  lastMessageDirection?: "in" | "out";

  /** Exceções do Painel → lista filtrada do pipeline. */
  exception?: "no_task" | "stalled" | "overdue" | "empty_value";
  /** Dias sem movimento para `exception=stalled`. Padrão 7. */
  stalledDays?: number;
};

/**
 * Aceita "YYYY-MM-DD" (data pura) e ISO completo. Para data pura,
 * retornamos o inicio do dia em UTC — quem chama decide se quer
 * estender pro fim do dia (ver `dateRangeBounds`).
 */
function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type DateBounds = { gte?: Date; lte?: Date };

/**
 * Converte um range "YYYY-MM-DD" do front em bounds Date para o Prisma.
 *
 * - `from` -> gte = inicio do dia UTC do `from`
 * - `to`   -> lte = fim do dia UTC do `to` (23:59:59.999)
 *
 * Nota timezone: comparamos em UTC. Para a maioria das aplicacoes
 * isso e "good enough" — se o dataset for sensivel a fuso, o usuario
 * pode usar "Personalizado" e definir horarios explicitos.
 */
function dateRangeBounds(range: DateRangeValue | undefined): DateBounds | undefined {
  if (!range) return undefined;
  const gte = parseDate(range.from);
  const lteStart = parseDate(range.to);
  if (!gte && !lteStart) return undefined;
  const f: DateBounds = {};
  if (gte) f.gte = gte;
  if (lteStart) {
    // Se o `to` veio como data pura (00:00 UTC), avanca pra 23:59:59.999
    // do mesmo dia UTC para abranger todo o dia.
    const isMidnightUtc =
      lteStart.getUTCHours() === 0 &&
      lteStart.getUTCMinutes() === 0 &&
      lteStart.getUTCSeconds() === 0 &&
      lteStart.getUTCMilliseconds() === 0;
    if (isMidnightUtc) {
      const end = new Date(lteStart);
      end.setUTCHours(23, 59, 59, 999);
      f.lte = end;
    } else {
      f.lte = lteStart;
    }
  }
  return f;
}

function isDateRangeValue(v: unknown): v is DateRangeValue {
  return !!v && typeof v === "object" && !Array.isArray(v) && ("from" in v || "to" in v);
}

/**
 * Custom fields são armazenados como STRING no DB (`value` em
 * `ContactCustomFieldValue`/`DealCustomFieldValue`).
 *
 * Para datas convertemos pra ISO/`YYYY-MM-DD` e comparamos lexicograficamente.
 * Funciona porque ISO-8601 é monotonicamente comparável como string.
 * Para `gt`/`lt` em campos numéricos, idem (somente faz sentido se o
 * usuário cadastrou números com padding consistente — limitação documentada).
 */
function buildContactCustomFieldClause(
  customFieldId: string,
  filter: CustomFieldFilter,
): Prisma.ContactWhereInput | null {
  const op = filter.operator ?? (filter.value ? "contains" : "filled");
  const valueStr = typeof filter.value === "string" ? filter.value.trim() : "";
  const valueArr = Array.isArray(filter.value) ? filter.value.filter(Boolean) : [];
  const range = isDateRangeValue(filter.value) ? filter.value : null;

  switch (op) {
    case "filled":
      return { customFields: { some: { customFieldId, value: { not: "" } } } };
    case "empty":
      return {
        OR: [
          { customFields: { none: { customFieldId } } },
          { customFields: { some: { customFieldId, value: "" } } },
        ],
      };
    case "eq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: valueStr } } };
    case "neq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { not: valueStr } } } };
    case "contains":
      if (!valueStr) return null;
      return {
        customFields: {
          some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
        },
      };
    case "not_contains":
      if (!valueStr) return null;
      return {
        NOT: {
          customFields: {
            some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
          },
        },
      };
    case "in":
      if (valueArr.length === 0) return null;
      return { customFields: { some: { customFieldId, value: { in: valueArr } } } };
    case "gt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "lt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "before":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "after":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "between": {
      if (!range || (!range.from && !range.to)) return null;
      const valueWhere: { gte?: string; lte?: string } = {};
      if (range.from) valueWhere.gte = range.from;
      if (range.to) valueWhere.lte = range.to;
      return { customFields: { some: { customFieldId, value: valueWhere } } };
    }
    default:
      return null;
  }
}

function buildDealCustomFieldClause(
  customFieldId: string,
  filter: CustomFieldFilter,
): Prisma.DealWhereInput | null {
  const op = filter.operator ?? (filter.value ? "contains" : "filled");
  const valueStr = typeof filter.value === "string" ? filter.value.trim() : "";
  const valueArr = Array.isArray(filter.value) ? filter.value.filter(Boolean) : [];
  const range = isDateRangeValue(filter.value) ? filter.value : null;

  switch (op) {
    case "filled":
      return { customFields: { some: { customFieldId, value: { not: "" } } } };
    case "empty":
      return {
        OR: [
          { customFields: { none: { customFieldId } } },
          { customFields: { some: { customFieldId, value: "" } } },
        ],
      };
    case "eq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: valueStr } } };
    case "neq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { not: valueStr } } } };
    case "contains":
      if (!valueStr) return null;
      return {
        customFields: {
          some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
        },
      };
    case "not_contains":
      if (!valueStr) return null;
      return {
        NOT: {
          customFields: {
            some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
          },
        },
      };
    case "in":
      if (valueArr.length === 0) return null;
      return { customFields: { some: { customFieldId, value: { in: valueArr } } } };
    case "gt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "lt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "before":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "after":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "between": {
      if (!range || (!range.from && !range.to)) return null;
      const valueWhere: { gte?: string; lte?: string } = {};
      if (range.from) valueWhere.gte = range.from;
      if (range.to) valueWhere.lte = range.to;
      return { customFields: { some: { customFieldId, value: valueWhere } } };
    }
    default:
      return null;
  }
}

/**
 * Condição de origem em cima do contato do deal, com suporte a
 * "Sem origem" (contato com source null/"" ou deal sem contato).
 */
function buildDealSourceCondition(
  sources?: string[],
  withoutSource?: boolean,
): Prisma.DealWhereInput | null {
  const real = (sources ?? []).filter((s) => s && s !== SOURCE_NONE);
  const wantNone = withoutSource === true || (sources ?? []).includes(SOURCE_NONE);
  const or: Prisma.DealWhereInput[] = [];
  if (real.length) or.push({ contact: { is: { source: { in: real } } } });
  if (wantNone) {
    or.push({
      OR: [
        { contactId: null },
        { contact: { is: { source: null } } },
        { contact: { is: { source: "" } } },
      ],
    });
  }
  if (or.length === 0) return null;
  return or.length === 1 ? or[0] : { OR: or };
}

/**
 * Traduz `AdvancedDealFilters` para `Prisma.DealWhereInput`.
 * O retorno deve ser somado às outras condições via `AND` em `dealWhere`.
 */
export async function buildDealWhereFromFilters(
  filters: AdvancedDealFilters,
): Promise<Prisma.DealWhereInput[]> {
  const conditions: Prisma.DealWhereInput[] = [];

  const search = filters.search?.trim();
  if (search) {
    const or = await buildDealSearchOr(search);
    if (or.length > 0) conditions.push({ OR: or });
  }

  if (filters.pipelineId) {
    conditions.push({ stage: { pipelineId: filters.pipelineId } });
  }

  if (filters.stageIds && filters.stageIds.length > 0) {
    conditions.push({ stageId: { in: filters.stageIds } });
  }

  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push({ status: { in: filters.statuses } });
  }

  // Responsável
  if (filters.withoutOwner) {
    conditions.push({ ownerId: null });
  } else if (filters.ownerIds && filters.ownerIds.length > 0) {
    const realIds = filters.ownerIds.filter((id): id is string => !!id);
    const hasNull = filters.ownerIds.some((id) => id === null);
    if (hasNull && realIds.length > 0) {
      conditions.push({ OR: [{ ownerId: null }, { ownerId: { in: realIds } }] });
    } else if (hasNull) {
      conditions.push({ ownerId: null });
    } else if (realIds.length > 0) {
      conditions.push({ ownerId: { in: realIds } });
    }
  }

  if (filters.withoutContact) {
    conditions.push({ contactId: null });
  }

  const sourceCond = buildDealSourceCondition(filters.sources, filters.withoutSource);
  if (sourceCond) conditions.push(sourceCond);

  if (filters.lostReasons && filters.lostReasons.length > 0) {
    conditions.push({ lostReason: { in: filters.lostReasons } });
  }

  // Tags
  if (filters.withoutTags) {
    conditions.push({ tags: { none: {} } });
  } else if (filters.tagIds && filters.tagIds.length > 0) {
    const ids = filters.tagIds;
    const mode = filters.tagMode ?? "any";
    if (mode === "any") {
      conditions.push({ tags: { some: { tagId: { in: ids } } } });
    } else if (mode === "all") {
      // todas: cada tag deve aparecer
      for (const tagId of ids) {
        conditions.push({ tags: { some: { tagId } } });
      }
    } else if (mode === "none") {
      conditions.push({ tags: { none: { tagId: { in: ids } } } });
    }
  }

  // Contato
  const contactSearch = filters.contactSearch?.trim();
  if (contactSearch) {
    conditions.push({
      contact: {
        is: {
          OR: [
            { name: { contains: contactSearch, mode: "insensitive" } },
            { email: { contains: contactSearch, mode: "insensitive" } },
            { phone: { contains: contactSearch } },
          ],
        },
      },
    });
  }
  if (filters.contactHasPhone === true) {
    conditions.push({ contact: { is: { phone: { not: null } } } });
  } else if (filters.contactHasPhone === false) {
    conditions.push({ contact: { is: { phone: null } } });
  }
  if (filters.contactHasEmail === true) {
    conditions.push({ contact: { is: { email: { not: null } } } });
  } else if (filters.contactHasEmail === false) {
    conditions.push({ contact: { is: { email: null } } });
  }

  // Datas
  const created = dateRangeBounds(filters.createdAt);
  if (created) conditions.push({ createdAt: { ...created } });
  const updated = dateRangeBounds(filters.updatedAt);
  if (updated) conditions.push({ updatedAt: { ...updated } });
  const closed = dateRangeBounds(filters.closedAt);
  if (closed) conditions.push({ closedAt: { ...closed } });
  const lastInter = dateRangeBounds(filters.lastInteractionAt);
  if (lastInter) {
    // proxy: última mensagem da conversation do contato
    conditions.push({
      contact: {
        is: {
          conversations: {
            some: { lastInboundAt: { ...lastInter } },
          },
        },
      },
    });
  }

  // Filtros de conversa (status + direção da última mensagem). Combinados no
  // MESMO `some` para casar a mesma conversation quando ambos estão ativos.
  {
    const convSome: Prisma.ConversationWhereInput = {};
    if (filters.conversationStatus === "open") convSome.status = { not: "RESOLVED" };
    else if (filters.conversationStatus === "closed") convSome.status = "RESOLVED";
    if (filters.lastMessageDirection === "in" || filters.lastMessageDirection === "out") {
      convSome.lastMessageDirection = filters.lastMessageDirection;
    }
    if (Object.keys(convSome).length > 0) {
      conditions.push({ contact: { is: { conversations: { some: convSome } } } });
    }
  }

  // Custom fields (Deal)
  if (filters.dealCustomFields && filters.dealCustomFields.length > 0) {
    const names = filters.dealCustomFields.map((f) => f.name.trim()).filter(Boolean);
    if (names.length > 0) {
      const defs = await prisma.customField.findMany({
        where: { entity: "deal", name: { in: names } },
        select: { id: true, name: true },
      });
      const byName = new Map(defs.map((d) => [d.name, d.id]));
      for (const f of filters.dealCustomFields) {
        const id = byName.get(f.name.trim());
        if (!id) continue;
        const clause = buildDealCustomFieldClause(id, f);
        if (clause) conditions.push(clause);
      }
    }
  }

  // Custom fields (Contact)
  if (filters.contactCustomFields && filters.contactCustomFields.length > 0) {
    const names = filters.contactCustomFields.map((f) => f.name.trim()).filter(Boolean);
    if (names.length > 0) {
      const defs = await prisma.customField.findMany({
        where: { entity: "contact", name: { in: names } },
        select: { id: true, name: true },
      });
      const byName = new Map(defs.map((d) => [d.name, d.id]));
      for (const f of filters.contactCustomFields) {
        const id = byName.get(f.name.trim());
        if (!id) continue;
        const clause = buildContactCustomFieldClause(id, f);
        if (clause) conditions.push({ contact: { is: clause } });
      }
    }
  }

  const exception = filters.exception;
  if (exception) {
    conditions.push({ status: "OPEN" });
    const now = new Date();
    if (exception === "no_task") {
      conditions.push({
        activities: { none: { completed: false, scheduledAt: { gte: now } } },
      });
    } else if (exception === "stalled") {
      const days =
        typeof filters.stalledDays === "number" &&
        Number.isFinite(filters.stalledDays) &&
        filters.stalledDays > 0 &&
        filters.stalledDays <= 365
          ? Math.round(filters.stalledDays)
          : 7;
      conditions.push({
        updatedAt: { lt: new Date(now.getTime() - days * 86_400_000) },
      });
    } else if (exception === "overdue") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      conditions.push({ expectedClose: { lt: start } });
    } else if (exception === "empty_value") {
      conditions.push({ value: { lte: 0 } });
    }
  }

  return conditions;
}

/**
 * Parse defensivo do body do cliente. Retorna `null` se o input não
 * for um objeto. Filtros desconhecidos são silenciosamente ignorados.
 */
/**
 * Operadores aceitos em CustomField. Mantenha sincronizado com a union
 * em `CustomFieldFilter.operator`.
 */
const CUSTOM_FIELD_OPS = new Set([
  "eq",
  "neq",
  "contains",
  "not_contains",
  "filled",
  "empty",
  "gt",
  "lt",
  "between",
  "before",
  "after",
  "in",
]);

function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return arr.length > 0 ? arr : undefined;
}

function asDateRange(v: unknown): DateRangeValue | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { from?: unknown; to?: unknown };
  const from = typeof r.from === "string" ? r.from : null;
  const to = typeof r.to === "string" ? r.to : null;
  if (!from && !to) return undefined;
  return { from, to };
}

function asCustomFieldFilter(v: unknown): CustomFieldFilter | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = asString(o.name);
  if (!name) return null;
  const operator =
    typeof o.operator === "string" && CUSTOM_FIELD_OPS.has(o.operator)
      ? (o.operator as CustomFieldFilter["operator"])
      : undefined;
  let value: CustomFieldFilter["value"];
  if (typeof o.value === "string") value = o.value;
  else if (Array.isArray(o.value)) {
    value = o.value.filter((x): x is string => typeof x === "string");
  } else if (o.value && typeof o.value === "object") {
    value = asDateRange(o.value) ?? null;
  } else {
    value = null;
  }
  return { name, operator, value };
}

function asCustomFieldArray(v: unknown): CustomFieldFilter[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CustomFieldFilter[] = [];
  for (const item of v) {
    const f = asCustomFieldFilter(item);
    if (f) out.push(f);
  }
  return out.length > 0 ? out : undefined;
}

const VALID_DEAL_STATUSES = new Set(["OPEN", "WON", "LOST"]);
const VALID_TAG_MODES = new Set(["any", "all", "none"]);

/**
 * Sanitiza/valida o payload recebido do cliente. Ignora campos
 * desconhecidos e descarta valores invalidos. Nunca quebra — sempre
 * devolve um objeto valido (potencialmente vazio).
 */
export function parseAdvancedDealFilters(input: unknown): AdvancedDealFilters {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const out: AdvancedDealFilters = {};

  if (o.logic === "AND" || o.logic === "OR") out.logic = o.logic;

  const search = asString(o.search);
  if (search) out.search = search;

  const pipelineId = asString(o.pipelineId);
  if (pipelineId) out.pipelineId = pipelineId;

  const stageIds = asStringArray(o.stageIds);
  if (stageIds) out.stageIds = stageIds;

  const statuses = asStringArray(o.statuses)?.filter((s) =>
    VALID_DEAL_STATUSES.has(s),
  ) as DealStatus[] | undefined;
  if (statuses && statuses.length > 0) out.statuses = statuses;

  // ownerIds aceita null como "sem responsavel"
  if (Array.isArray(o.ownerIds)) {
    const owners = o.ownerIds.filter(
      (x): x is string | null => x === null || (typeof x === "string" && x.trim().length > 0),
    );
    if (owners.length > 0) out.ownerIds = owners;
  }
  const wo = asBool(o.withoutOwner);
  if (wo) out.withoutOwner = wo;
  const wc = asBool(o.withoutContact);
  if (wc) out.withoutContact = wc;

  const sources = asStringArray(o.sources);
  if (sources) out.sources = sources;
  const ws = asBool(o.withoutSource);
  if (ws) out.withoutSource = ws;

  const lostReasons = asStringArray(o.lostReasons);
  if (lostReasons) out.lostReasons = lostReasons;

  const tagIds = asStringArray(o.tagIds);
  if (tagIds) out.tagIds = tagIds;
  if (typeof o.tagMode === "string" && VALID_TAG_MODES.has(o.tagMode)) {
    out.tagMode = o.tagMode as "any" | "all" | "none";
  }
  const wt = asBool(o.withoutTags);
  if (wt) out.withoutTags = wt;

  const contactSearch = asString(o.contactSearch);
  if (contactSearch) out.contactSearch = contactSearch;
  const chp = asBool(o.contactHasPhone);
  if (chp !== undefined) out.contactHasPhone = chp;
  const che = asBool(o.contactHasEmail);
  if (che !== undefined) out.contactHasEmail = che;

  const created = asDateRange(o.createdAt);
  if (created) out.createdAt = created;
  const updated = asDateRange(o.updatedAt);
  if (updated) out.updatedAt = updated;
  const closed = asDateRange(o.closedAt);
  if (closed) out.closedAt = closed;
  const lastI = asDateRange(o.lastInteractionAt);
  if (lastI) out.lastInteractionAt = lastI;

  const dealCfs = asCustomFieldArray(o.dealCustomFields);
  if (dealCfs) out.dealCustomFields = dealCfs;
  const contactCfs = asCustomFieldArray(o.contactCustomFields);
  if (contactCfs) out.contactCustomFields = contactCfs;

  if (o.conversationStatus === "open" || o.conversationStatus === "closed") {
    out.conversationStatus = o.conversationStatus;
  }
  if (o.lastMessageDirection === "in" || o.lastMessageDirection === "out") {
    out.lastMessageDirection = o.lastMessageDirection;
  }

  if (
    o.exception === "no_task" ||
    o.exception === "stalled" ||
    o.exception === "overdue" ||
    o.exception === "empty_value"
  ) {
    out.exception = o.exception;
  }
  {
    const n = Number(o.stalledDays);
    if (Number.isFinite(n)) {
      const days = Math.round(n);
      if (days > 0 && days <= 365) out.stalledDays = days;
    }
  }

  return out;
}

/**
 * Lê os filtros avançados de uma querystring: `filters` (JSON) ou `f`
 * (base64url do mesmo JSON, usado quando o payload é grande demais para a URL
 * legível). Devolve `{}` quando não há filtro válido.
 */
export function parseAdvancedDealFiltersFromParams(
  searchParams: URLSearchParams,
): AdvancedDealFilters {
  const raw = searchParams.get("filters");
  if (raw) {
    try {
      const parsed = parseAdvancedDealFilters(JSON.parse(raw));
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
      /* ignora filters inválido */
    }
  }
  const f = searchParams.get("f");
  if (f) {
    try {
      const b64 = f.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
      const json = Buffer.from(b64 + pad, "base64").toString("utf8");
      return parseAdvancedDealFilters(JSON.parse(json));
    } catch {
      /* ignora f inválido */
    }
  }
  return {};
}
