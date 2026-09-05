import type { LifecycleStage, Prisma } from "@prisma/client";

import { defaultDealTitleForContact, sanitizeContactName } from "@/lib/display-name";
import { resolveHighlight, type ResolvedHighlight } from "@/lib/highlight";
import { normalizePhone, phoneMatchVariants } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow, getRequestContext } from "@/lib/request-context";
import { enrichContactsWithUserAvatarFallback } from "@/lib/contact-avatar-fallback";
import { getLogger } from "@/lib/logger";
import { logEvent } from "@/services/activity-log";
import { resolveContactSearchCandidates } from "@/services/kanban-filters";

const log = getLogger("contacts-service");

/**
 * Normaliza o telefone recebido em Create/Update para E.164 (BR-first).
 * Se o input for null/undefined, propaga o valor original.
 *
 * Até 04/ago/26 o valor cru era mantido quando a normalização falhava, "para
 * não descartar entrada do usuário". O efeito real foi o oposto: integrações
 * gravaram coisas como `"+5585991940125, +558591940125"` e `"Farmácia"`, que
 * passam no `replace(/\D/g, "")` do envio e viram números impossíveis na
 * Meta — contato inalcançável sem nenhum sinal de erro.
 *
 * As rotas de escrita rejeitam com 400 (`parseContactPhoneInput`). Aqui, nos
 * caminhos internos que não têm ninguém para corrigir na hora (webhook Meta,
 * importação, merge), descartamos e registramos: campo vazio é honesto,
 * telefone falso não.
 */
function normalizeContactPhoneInput(
  input: string | null | undefined,
): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = normalizePhone(trimmed);
  if (!normalized) {
    log.warn({ phone: trimmed }, "telefone nao normalizavel descartado");
    return null;
  }
  return normalized;
}

const LIFECYCLE_STAGES: LifecycleStage[] = [
  "SUBSCRIBER",
  "LEAD",
  "MQL",
  "SQL",
  "OPPORTUNITY",
  "CUSTOMER",
  "EVANGELIST",
  "OTHER",
];

export function isValidLifecycleStage(v: string): v is LifecycleStage {
  return LIFECYCLE_STAGES.includes(v as LifecycleStage);
}

/**
 * Inbox e ficha do contato só enxergavam `Deal.contactId === contato`.
 * Negócio no funil sem vínculo (import, contato apagado, card criado
 * pelo nome) ou gravado num duplicata com o mesmo telefone/e-mail
 * sumia do painel — o operador via o deal no CRM e o aside vazio.
 */
export function dealsWhereForContact(
  contactId: string,
  phone: string | null | undefined,
  email: string | null | undefined,
  name: string | null | undefined,
): Prisma.DealWhereInput {
  const or: Prisma.DealWhereInput[] = [{ contactId }];

  const variants = phoneMatchVariants(phone);
  if (variants.length > 0) {
    or.push({ contact: { phone: { in: variants } } });
  }

  const emailNorm = email?.trim();
  if (emailNorm) {
    or.push({
      contact: { email: { equals: emailNorm, mode: "insensitive" } },
    });
  }

  const titles = new Set<string>();
  const person = (name ?? "").trim();
  if (person) {
    titles.add(person);
    titles.add(`Negócio ${person}`);
    titles.add(`Negócio - ${person}`);
    const auto = defaultDealTitleForContact(person);
    if (auto) titles.add(auto);
  }
  if (titles.size > 0) {
    or.push({
      contactId: null,
      status: "OPEN",
      OR: [...titles].map((title) => ({
        title: { equals: title, mode: "insensitive" as const },
      })),
    });
  }

  return { OR: or };
}

export type ContactCustomFieldFilter = {
  /** Nome do CustomField (ex.: curso_interesse, graduacao). */
  name: string;
  /** eq | contains | filled (tem valor não vazio). */
  operator?: "eq" | "contains" | "filled";
  value?: string;
};

export type GetContactsParams = {
  search?: string;
  lifecycleStage?: LifecycleStage;
  tagIds?: string[];
  companyId?: string;
  /** Filtra contatos sem responsável atribuído (assignedToId = null). */
  unassigned?: boolean;
  /** Filtros por campos customizados do contato (AND entre itens). */
  customFieldFilters?: ContactCustomFieldFilter[];
  /**
   * Match EXATO de email (case-insensitive). Pensado para integrações que
   * precisam responder "esse lead já existe?" sem o ruído do `search`
   * (que faz contains em vários campos e pode retornar falsos positivos).
   */
  emailExact?: string;
  /**
   * Match EXATO de telefone, tolerante a formatação. Se o input vier com
   * 8+ dígitos, casamos tanto pelo valor cru salvo no DB quanto pelos
   * últimos N dígitos (endsWith), absorvendo variações como `+5511...`
   * vs `(11) 9...`. Para n8n: passe só dígitos no query param.
   */
  phoneExact?: string;
  /**
   * Match EXATO de `Contact.adSourceId` (id do post/anúncio Meta CTWA
   * gravado pelo webhook Meta em `referral.source_id`). Pensado para
   * integrações (n8n) que querem enumerar todos os contatos originados
   * de um anúncio ou post específico — antes só era possível via SQL
   * direto. Case-sensitive porque a Meta grava o id como string opaca.
   */
  adSourceId?: string;
  /** Intervalo de criação (createdAt). */
  createdFrom?: Date;
  createdTo?: Date;
  /** Intervalo de última modificação (updatedAt). */
  updatedFrom?: Date;
  updatedTo?: Date;
  page?: number;
  perPage?: number;
  sortBy?: "name" | "email" | "createdAt" | "updatedAt" | "leadScore" | "lifecycleStage";
  sortOrder?: "asc" | "desc";
};

function idsLengthForCappedSearch(where: Prisma.ContactWhereInput): number {
  const id = where.id;
  if (id && typeof id === "object" && "in" in id && Array.isArray(id.in)) {
    return id.in.length;
  }
  return 0;
}

const assignedToSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  role: true,
} satisfies Prisma.UserSelect;

export async function getContacts(params: GetContactsParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  // 27/mai/26 — Cap subido de 100 → 200 pra permitir o operador
  // listar mais leads por página (UI ganhou seletor 20/50/100/200).
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;
  const sortBy = params.sortBy ?? "createdAt";
  const sortOrder = params.sortOrder ?? "desc";

  const search = params.search?.trim();
  const where: Prisma.ContactWhereInput = {};
  let searchCapped = false;

  if (search) {
    const orgId = getOrgIdOrThrow();
    const { ids, capped } = await resolveContactSearchCandidates(search);
    searchCapped = capped;
    if (ids.length === 0) {
      return {
        items: [],
        total: 0,
        page,
        perPage,
        totalPages: 1,
        hasMore: false,
      };
    }
    where.organizationId = orgId;
    where.id = { in: ids };
  }

  if (params.customFieldFilters && params.customFieldFilters.length > 0) {
    const fieldNames = params.customFieldFilters.map((f) => f.name.trim()).filter(Boolean);
    if (fieldNames.length > 0) {
      const defs = await prisma.customField.findMany({
        where: { entity: "contact", name: { in: fieldNames } },
        select: { id: true, name: true },
      });
      const byName = new Map(defs.map((d) => [d.name, d.id]));

      const andFilters: Prisma.ContactWhereInput[] = [];
      for (const f of params.customFieldFilters) {
        const name = f.name.trim();
        const fieldId = byName.get(name);
        if (!fieldId) continue;

        const op = f.operator ?? (f.value ? "eq" : "filled");
        if (op === "filled") {
          andFilters.push({
            customFields: {
              some: {
                customFieldId: fieldId,
                value: { not: "" },
              },
            },
          });
        } else if (op === "contains" && f.value?.trim()) {
          andFilters.push({
            customFields: {
              some: {
                customFieldId: fieldId,
                value: { contains: f.value.trim(), mode: "insensitive" },
              },
            },
          });
        } else if (f.value !== undefined) {
          andFilters.push({
            customFields: {
              some: {
                customFieldId: fieldId,
                value: f.value,
              },
            },
          });
        }
      }

      if (andFilters.length > 0) {
        where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...andFilters];
      }
    }
  }

  if (params.lifecycleStage) {
    where.lifecycleStage = params.lifecycleStage;
  }

  if (params.companyId) {
    where.companyId = params.companyId;
  }

  if (params.tagIds && params.tagIds.length > 0) {
    where.tags = {
      some: { tagId: { in: params.tagIds } },
    };
  }

  if (params.unassigned) {
    where.assignedToId = null;
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (params.createdFrom) createdAt.gte = params.createdFrom;
  if (params.createdTo) createdAt.lte = params.createdTo;
  if (createdAt.gte || createdAt.lte) where.createdAt = createdAt;

  const updatedAt: Prisma.DateTimeFilter = {};
  if (params.updatedFrom) updatedAt.gte = params.updatedFrom;
  if (params.updatedTo) updatedAt.lte = params.updatedTo;
  if (updatedAt.gte || updatedAt.lte) where.updatedAt = updatedAt;

  const exactFilters: Prisma.ContactWhereInput[] = [];

  const emailExact = params.emailExact?.trim().toLowerCase();
  if (emailExact) {
    exactFilters.push({
      email: { equals: emailExact, mode: "insensitive" },
    });
  }

  const phoneRaw = params.phoneExact?.trim();
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D/g, "");
    const phoneOr: Prisma.ContactWhereInput[] = [{ phone: { equals: phoneRaw } }];
    if (digits && digits.length >= 8) {
      phoneOr.push({ phone: { endsWith: digits } });
    }
    exactFilters.push(phoneOr.length === 1 ? phoneOr[0] : { OR: phoneOr });
  }

  const adSourceIdRaw = params.adSourceId?.trim();
  if (adSourceIdRaw) {
    exactFilters.push({ adSourceId: adSourceIdRaw });
  }

  if (exactFilters.length > 0) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...exactFilters];
  }

  const orderBy: Prisma.ContactOrderByWithRelationInput = (() => {
    switch (sortBy) {
      case "name":
        return { name: sortOrder };
      case "email":
        return { email: sortOrder };
      case "leadScore":
        return { leadScore: sortOrder };
      case "lifecycleStage":
        return { lifecycleStage: sortOrder };
      case "updatedAt":
        return { updatedAt: sortOrder };
      default:
        return { createdAt: sortOrder };
    }
  })();

  const [rawItems, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      skip,
      take: perPage,
      orderBy,
      select: {
        id: true,
        number: true,
        name: true,
        email: true,
        phone: true,
        avatarUrl: true,
        leadScore: true,
        lifecycleStage: true,
        source: true,
        createdAt: true,
        updatedAt: true,
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
        company: { select: { id: true, number: true, name: true, domain: true } },
        tags: {
          select: { tag: { select: { id: true, name: true, color: true } } },
        },
        customFields: { select: { customFieldId: true, value: true } },
      },
    }),
    searchCapped
      ? Promise.resolve(idsLengthForCappedSearch(where))
      : prisma.contact.count({ where }),
  ]);

  await enrichContactsWithUserAvatarFallback(rawItems);

  const contactIds = rawItems.map((c) => c.id);

  let dealAggMap = new Map<
    string,
    { totalValue: number; dealCount: number; lastDealAt: Date | null; firstDealAt: Date | null }
  >();

  if (contactIds.length > 0) {
    const orgId = getOrgIdOrThrow();
    const dealAggs = await prisma.$queryRaw<
      { contactId: string; totalValue: string; dealCount: bigint; lastDealAt: Date | null; firstDealAt: Date | null }[]
    >`
      SELECT
        d."contactId",
        COALESCE(SUM(d.value), 0) as "totalValue",
        COUNT(d.id) as "dealCount",
        MAX(d."createdAt") as "lastDealAt",
        MIN(d."createdAt") as "firstDealAt"
      FROM deals d
      WHERE d."contactId" = ANY(${contactIds})
        AND d.status = 'WON'
        AND d."organizationId" = ${orgId}
      GROUP BY d."contactId"
    `;

    dealAggMap = new Map(
      dealAggs.map((r) => [
        r.contactId,
        {
          totalValue: parseFloat(r.totalValue) || 0,
          dealCount: Number(r.dealCount),
          lastDealAt: r.lastDealAt,
          firstDealAt: r.firstDealAt,
        },
      ]),
    );
  }

  const items = rawItems.map((c) => {
    const agg = dealAggMap.get(c.id);
    const dealCount = agg?.dealCount ?? 0;
    const totalValue = agg?.totalValue ?? 0;
    const avgTicket = dealCount > 0 ? totalValue / dealCount : 0;
    const lastDealAt = agg?.lastDealAt ?? null;
    const firstDealAt = agg?.firstDealAt ?? null;

    let purchaseCycleDays = 0;
    if (firstDealAt && lastDealAt && dealCount > 1) {
      purchaseCycleDays = Math.round(
        (lastDealAt.getTime() - firstDealAt.getTime()) / (1000 * 60 * 60 * 24) / (dealCount - 1),
      );
    }

    let daysSinceLastPurchase = 0;
    if (lastDealAt) {
      daysSinceLastPurchase = Math.round(
        (Date.now() - lastDealAt.getTime()) / (1000 * 60 * 60 * 24),
      );
    }

    const customFields = Object.fromEntries(
      (c.customFields ?? []).map((v) => [v.customFieldId, v.value]),
    ) as Record<string, string>;

    return {
      ...c,
      tags: c.tags.map((t) => t.tag),
      customFields,
      totalValue,
      dealCount,
      avgTicket,
      purchaseCycleDays,
      daysSinceLastPurchase,
    };
  });

  return {
    items,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
    hasMore: searchCapped,
  };
}

export type ContactStats = {
  total: number;
  unassigned: number;
  byStage: Record<LifecycleStage, number>;
};

/**
 * Contagens agregadas por segmento para os stat cards do diretório.
 * Escopo por organização é aplicado automaticamente pela extensão do Prisma.
 */
export async function getContactStats(): Promise<ContactStats> {
  const [total, unassigned, byStageRaw] = await Promise.all([
    prisma.contact.count(),
    prisma.contact.count({ where: { assignedToId: null } }),
    prisma.contact.groupBy({ by: ["lifecycleStage"], _count: { _all: true } }),
  ]);

  const byStage = Object.fromEntries(
    LIFECYCLE_STAGES.map((stage) => [stage, 0]),
  ) as Record<LifecycleStage, number>;
  for (const row of byStageRaw) {
    byStage[row.lifecycleStage] = row._count._all;
  }

  return { total, unassigned, byStage };
}

export type CreateContactInput = {
  /** Só importação / migração: fixar o mesmo id do export. */
  id?: string;
  /** ID externo (ex.: Kommo) para reimportar sem duplicar. */
  externalId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  leadScore?: number;
  lifecycleStage?: LifecycleStage;
  source?: string | null;
  companyId?: string | null;
  assignedToId?: string | null;
  /** Rastreio / UTM (estilo Kommo). Null limpa; undefined ignora. */
  adUtmSource?: string | null;
  adUtmMedium?: string | null;
  adUtmCampaign?: string | null;
  adUtmContent?: string | null;
  adUtmTerm?: string | null;
  utmId?: string | null;
  utmReferrer?: string | null;
  referrer?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  googleClientId?: string | null;
  ttadId?: string | null;
  ttadName?: string | null;
};

export type UpdateContactInput = Partial<CreateContactInput>;

function dealValueToString(value: Prisma.Decimal) {
  return value.toString();
}

export type InboxLeadPanelFieldRow = {
  fieldId: string;
  name: string;
  label: string;
  type: string;
  options: string[];
  value: string | null;
  highlightRules: unknown[];
  highlight: ResolvedHighlight | null;
};

/** Campos de contato marcados para o painel Lead na Inbox (com valor ou vazio). */
export async function getInboxLeadPanelFieldsForContact(
  contactId: string
): Promise<InboxLeadPanelFieldRow[]> {
  const fields = await prisma.customField.findMany({
    where: { entity: "contact", showInInboxLeadPanel: true },
  });
  fields.sort(
    (a, b) =>
      (a.inboxLeadPanelOrder ?? 9999) - (b.inboxLeadPanelOrder ?? 9999) ||
      a.label.localeCompare(b.label, "pt-BR")
  );

  if (fields.length === 0) return [];

  const fieldIds = fields.map((f) => f.id);
  const values = await prisma.contactCustomFieldValue.findMany({
    where: { contactId, customFieldId: { in: fieldIds } },
    select: { customFieldId: true, value: true },
  });
  const valueByField = new Map(values.map((v) => [v.customFieldId, v.value]));

  return fields.map((f) => {
    const value = valueByField.get(f.id) ?? null;
    return {
      fieldId: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      options: f.options,
      value,
      highlightRules: Array.isArray(f.highlightRules) ? f.highlightRules : [],
      highlight: resolveHighlight(value, f.highlightRules),
    };
  });
}

/** Campos de negócio marcados para o painel lateral na Inbox (com valor ou vazio). */
export async function getInboxLeadPanelFieldsForDeal(
  dealId: string
): Promise<InboxLeadPanelFieldRow[]> {
  let fields: Awaited<ReturnType<typeof prisma.customField.findMany>>;
  try {
    fields = await prisma.customField.findMany({
      where: { entity: "deal", showInInboxLeadPanel: true },
    });
  } catch {
    // Fallback: coluna showInDealPanel ainda não foi migrada. Um findMany
    // (mesmo filtrando por showInInboxLeadPanel) ainda SELECIONA showInDealPanel
    // e falharia de novo — por isso usamos raw sem referenciar a coluna ausente.
    const ctx = getRequestContext();
    const orgId = ctx?.organizationId ?? null;
    const rows = orgId
      ? await prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT id, name, label, "type", options, required, entity,
                 "showInInboxLeadPanel", "inboxLeadPanelOrder",
                 "highlightRules", "organizationId"
          FROM custom_fields
          WHERE entity = 'deal' AND "showInInboxLeadPanel" = true
            AND "organizationId" = ${orgId}
        `
      : await prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT id, name, label, "type", options, required, entity,
                 "showInInboxLeadPanel", "inboxLeadPanelOrder",
                 "highlightRules", "organizationId"
          FROM custom_fields
          WHERE entity = 'deal' AND "showInInboxLeadPanel" = true
        `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fields = rows.map((r) => ({ ...r, showInDealPanel: false })) as any;
  }
  fields.sort(
    (a, b) =>
      (a.inboxLeadPanelOrder ?? 9999) - (b.inboxLeadPanelOrder ?? 9999) ||
      a.label.localeCompare(b.label, "pt-BR")
  );

  if (fields.length === 0) return [];

  const fieldIds = fields.map((f) => f.id);
  const values = await prisma.dealCustomFieldValue.findMany({
    where: { dealId, customFieldId: { in: fieldIds } },
    select: { customFieldId: true, value: true },
  });
  const valueByField = new Map(values.map((v) => [v.customFieldId, v.value]));

  return fields.map((f) => {
    const value = valueByField.get(f.id) ?? null;
    return {
      fieldId: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      options: f.options,
      value,
      highlightRules: Array.isArray(f.highlightRules) ? f.highlightRules : [],
      highlight: resolveHighlight(value, f.highlightRules),
    };
  });
}

/**
 * Versão em LOTE de `getInboxLeadPanelFieldsForDeal` para vários negócios de
 * uma vez. Retorna um mapa `dealId → campos` (cada negócio recebe TODOS os
 * custom fields marcados para o painel da Inbox, com o valor daquele negócio
 * ou null). Faz 2 queries no total (defs + valores de todos os deals) em vez
 * de 2 por negócio — usado no painel do contato, que pode ter vários cards.
 */
export async function getInboxLeadPanelFieldsForDeals(
  dealIds: string[]
): Promise<Record<string, InboxLeadPanelFieldRow[]>> {
  const result: Record<string, InboxLeadPanelFieldRow[]> = {};
  if (dealIds.length === 0) return result;

  const fields = await prisma.customField.findMany({
    where: { entity: "deal", showInInboxLeadPanel: true },
  });
  fields.sort(
    (a, b) =>
      (a.inboxLeadPanelOrder ?? 9999) - (b.inboxLeadPanelOrder ?? 9999) ||
      a.label.localeCompare(b.label, "pt-BR")
  );
  if (fields.length === 0) return result;

  const fieldIds = fields.map((f) => f.id);
  const values = await prisma.dealCustomFieldValue.findMany({
    where: { dealId: { in: dealIds }, customFieldId: { in: fieldIds } },
    select: { dealId: true, customFieldId: true, value: true },
  });

  const byDeal = new Map<string, Map<string, string>>();
  for (const v of values) {
    let m = byDeal.get(v.dealId);
    if (!m) {
      m = new Map<string, string>();
      byDeal.set(v.dealId, m);
    }
    m.set(v.customFieldId, v.value);
  }

  for (const dealId of dealIds) {
    const valueByField = byDeal.get(dealId) ?? new Map<string, string>();
    result[dealId] = fields.map((f) => {
      const value = valueByField.get(f.id) ?? null;
      return {
        fieldId: f.id,
        name: f.name,
        label: f.label,
        type: f.type,
        options: f.options,
        value,
        highlightRules: Array.isArray(f.highlightRules) ? f.highlightRules : [],
        highlight: resolveHighlight(value, f.highlightRules),
      };
    });
  }

  return result;
}

/**
 * Campos de negócio marcados para o painel do Deal Detail (com valor ou vazio).
 * Filtra por showInDealPanel em vez de showInInboxLeadPanel — visibilidade
 * configurada separadamente da Inbox. Fallback resiliente para quando a coluna
 * ainda não existe na DB.
 */
export async function getDealPanelFieldsForDeal(
  dealId: string
): Promise<InboxLeadPanelFieldRow[]> {
  let fields: Awaited<ReturnType<typeof prisma.customField.findMany>>;
  try {
    fields = await prisma.customField.findMany({
      where: { entity: "deal", showInDealPanel: true },
    });
  } catch {
    // Fallback: coluna showInDealPanel ainda não foi migrada. Um findMany
    // (mesmo filtrando por showInInboxLeadPanel) ainda SELECIONA showInDealPanel
    // e falharia de novo — por isso usamos raw sem referenciar a coluna ausente.
    const ctx = getRequestContext();
    const orgId = ctx?.organizationId ?? null;
    const rows = orgId
      ? await prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT id, name, label, "type", options, required, entity,
                 "showInInboxLeadPanel", "inboxLeadPanelOrder",
                 "highlightRules", "organizationId"
          FROM custom_fields
          WHERE entity = 'deal' AND "showInInboxLeadPanel" = true
            AND "organizationId" = ${orgId}
        `
      : await prisma.$queryRaw<Record<string, unknown>[]>`
          SELECT id, name, label, "type", options, required, entity,
                 "showInInboxLeadPanel", "inboxLeadPanelOrder",
                 "highlightRules", "organizationId"
          FROM custom_fields
          WHERE entity = 'deal' AND "showInInboxLeadPanel" = true
        `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fields = rows.map((r) => ({ ...r, showInDealPanel: false })) as any;
  }

  fields.sort((a, b) =>
    (a.inboxLeadPanelOrder ?? 9999) - (b.inboxLeadPanelOrder ?? 9999) ||
    a.label.localeCompare(b.label, "pt-BR")
  );

  if (fields.length === 0) return [];

  const fieldIds = fields.map((f) => f.id);
  const values = await prisma.dealCustomFieldValue.findMany({
    where: { dealId, customFieldId: { in: fieldIds } },
    select: { customFieldId: true, value: true },
  });
  const valueByField = new Map(values.map((v) => [v.customFieldId, v.value]));

  return fields.map((f) => {
    const value = valueByField.get(f.id) ?? null;
    return {
      fieldId: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      options: f.options,
      value,
      highlightRules: Array.isArray(f.highlightRules) ? f.highlightRules : [],
      highlight: resolveHighlight(value, f.highlightRules),
    };
  });
}

/**
 * Verifica apenas se existe um contato com o id. Usa findUnique mínimo
 * (sem includes) pra não arrastar falhas de relações — garantindo que
 * endpoints DELETE/PUT possam checar existência mesmo quando alguma
 * relação (tags, deals, conversations) estiver em estado inconsistente.
 */
export async function contactExists(id: string): Promise<boolean> {
  try {
    const row = await prisma.contact.findUnique({
      where: { id },
      select: { id: true },
    });
    return !!row;
  } catch (err) {
    log.error(`contactExists(${id}) falhou:`, err);
    throw err;
  }
}

/**
 * Carrega o contato + relações. Historicamente fazia 1 findUnique com
 * include aninhado gigante; se QUALQUER relação falhasse (schema drift,
 * registro órfão, cliente Prisma fora de sincronia) a query toda era
 * derrubada e o endpoint acabava retornando 404 "Contato não encontrado"
 * ou 500 genérico — exatamente o sintoma "não consigo abrir nenhum
 * contato".
 *
 * Agora: busca o core separado e cada relação em paralelo, com try/catch
 * individual. Se o core existe mas uma relação falha, a relação vira
 * array vazio e o contato ainda é renderizado.
 */
export type GetContactByIdOptions = {
  /**
   * Inbox aside: pula activities/notes/conversations (não usados no painel
   * negócio no cold path). Mantém deals + panel fields.
   */
  view?: "full" | "inbox";
};

export async function getContactById(
  id: string,
  options: GetContactByIdOptions = {},
) {
  const view = options.view ?? "full";
  let core: Awaited<ReturnType<typeof prisma.contact.findUnique>> | null = null;
  try {
    core = await prisma.contact.findUnique({ where: { id } });
  } catch (err) {
    log.error(`findUnique(core) falhou para contato ${id}:`, err);
    throw err;
  }

  if (!core) {
    log.debug(`contato ${id} não encontrado (findUnique core retornou null)`);
    return null;
  }

  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.error(`getContactById(${id}): falha carregando "${label}" — retornando fallback:`, err);
      return fallback;
    }
  };

  const emptyActivities = [] as Awaited<
    ReturnType<
      typeof prisma.activity.findMany<{
        include: {
          user: { select: typeof assignedToSelect };
          deal: { select: { id: true; title: true } };
        };
      }>
    >
  >;
  const emptyNotes = [] as Awaited<
    ReturnType<
      typeof prisma.note.findMany<{
        include: { user: { select: typeof assignedToSelect } };
      }>
    >
  >;
  const emptyConversations = [] as Awaited<
    ReturnType<
      typeof prisma.conversation.findMany<{
        select: {
          id: true;
          externalId: true;
          channel: true;
          status: true;
          inboxName: true;
          createdAt: true;
          updatedAt: true;
          assignedToId: true;
          assignedTo: { select: { id: true; name: true; email: true } };
          channelRef: { select: { id: true; name: true; type: true; phoneNumber: true } };
        };
      }>
    >
  >;

  const [
    company,
    assignedTo,
    tags,
    activities,
    deals,
    notes,
    conversations,
    inboxLeadPanelFields,
  ] = await Promise.all([
    core.companyId
      ? safe(
          "company",
          () =>
            prisma.company.findUnique({
              where: { id: core!.companyId! },
              select: { id: true, number: true, name: true, domain: true },
            }),
          null,
        )
      : Promise.resolve(null),
    core.assignedToId
      ? safe(
          "assignedTo",
          () =>
            prisma.user.findUnique({
              where: { id: core!.assignedToId! },
              select: assignedToSelect,
            }),
          null,
        )
      : Promise.resolve(null),
    safe(
      "tags",
      () =>
        prisma.tagOnContact.findMany({
          where: { contactId: id },
          include: { tag: { select: { id: true, name: true, color: true } } },
        }),
      [] as Array<{ contactId: string; tagId: string; tag: { id: string; name: string; color: string | null } }>,
    ),
    view === "inbox"
      ? Promise.resolve(emptyActivities)
      : safe(
          "activities",
          () =>
            prisma.activity.findMany({
              where: { contactId: id },
              take: 20,
              orderBy: { createdAt: "desc" },
              include: {
                user: { select: assignedToSelect },
                deal: { select: { id: true, title: true } },
              },
            }),
          emptyActivities,
        ),
    safe(
      "deals",
      () =>
        prisma.deal.findMany({
          where: dealsWhereForContact(id, core.phone, core.email, core.name),
          take: 20,
          orderBy: { updatedAt: "desc" },
          include: {
            // pipelineId é incluído via stage.pipelineId — Deal não tem
            // pipelineId direto no schema. O frontend (contact-aside +
            // inbox v2) usa `stageName`/`pipelineId` flat, então o map
            // de retorno achata para esse formato.
            stage: { select: { id: true, name: true, color: true, pipelineId: true, pipeline: { select: { name: true } } } },
            owner: { select: assignedToSelect },
          },
        }),
      [] as Awaited<
        ReturnType<
          typeof prisma.deal.findMany<{
            include: {
              stage: { select: { id: true; name: true; color: true; pipelineId: true; pipeline: { select: { name: true } } } };
              owner: { select: typeof assignedToSelect };
            };
          }>
        >
      >,
    ),
    view === "inbox"
      ? Promise.resolve(emptyNotes)
      : safe(
          "notes",
          () =>
            prisma.note.findMany({
              where: { contactId: id },
              take: 30,
              orderBy: { createdAt: "desc" },
              include: { user: { select: assignedToSelect } },
            }),
          emptyNotes,
        ),
    view === "inbox"
      ? Promise.resolve(emptyConversations)
      : safe(
          "conversations",
          () =>
            prisma.conversation.findMany({
              where: { contactId: id },
              take: 50,
              orderBy: { updatedAt: "desc" },
              select: {
                id: true,
                externalId: true,
                channel: true,
                status: true,
                inboxName: true,
                createdAt: true,
                updatedAt: true,
                assignedToId: true,
                assignedTo: { select: { id: true, name: true, email: true } },
                channelRef: { select: { id: true, name: true, type: true, phoneNumber: true } },
              },
            }),
          emptyConversations,
        ),
    safe("inboxLeadPanelFields", () => getInboxLeadPanelFieldsForContact(id), [] as InboxLeadPanelFieldRow[]),
  ]);

  // Campos de painel de TODOS os negócios do contato (não só o "primeiro
  // aberto"). O frontend abre um negócio específico e busca
  // `dealInboxPanelFields[dealAberto]` — se preenchêssemos só um negócio, abrir
  // qualquer outro do mesmo contato (ex.: reimport que gerou 2 cards) mostraria
  // a lateral vazia. Batched: 1 query pros defs + 1 pros valores de todos.
  const orphanOpenIds = deals
    .filter((d) => d.contactId == null && d.status === "OPEN")
    .map((d) => d.id);
  if (orphanOpenIds.length > 0) {
    prisma.deal
      .updateMany({
        where: { id: { in: orphanOpenIds }, contactId: null },
        data: { contactId: id },
      })
      .catch((err) =>
        log.warn({ err, contactId: id }, "falha ao vincular negocios orfaos ao contato"),
      );
  }

  const dealInboxPanelFields: Record<string, InboxLeadPanelFieldRow[]> =
    deals.length > 0
      ? await safe(
          "dealInboxPanelFields",
          () => getInboxLeadPanelFieldsForDeals(deals.map((d) => d.id)),
          {} as Record<string, InboxLeadPanelFieldRow[]>,
        )
      : {};

  return {
    ...core,
    company,
    assignedTo,
    tags,
    activities,
    // Achata `stage.{name,color,pipelineId}` para o formato esperado
    // pelo frontend (`stageName`, `stageColor`, `pipelineId`). Sem isso
    // o contact-aside / inbox sidebar mostrava "Sem estágio" mesmo
    // quando o deal tinha stageId válido no banco.
    deals: deals.map((d) => ({
      ...d,
      value: dealValueToString(d.value),
      stageName: d.stage?.name ?? null,
      stageColor: d.stage?.color ?? null,
      pipelineId: d.stage?.pipelineId ?? null,
      pipelineName: d.stage?.pipeline?.name ?? null,
    })),
    notes,
    conversations,
    inboxLeadPanelFields,
    dealInboxPanelFields,
  };
}

/**
 * Aloca o próximo `Contact.number` da org sob advisory lock **na mesma
 * transaction** do INSERT. `MAX+1` sem lock colidia sob webhook/import
 * concorrente (P2002 em `contacts_organization_id_number_key` — DNAWork
 * ago/26). O lock é `xact` → liberado no commit/rollback da tx.
 */
export async function allocateNextContactNumber(
  tx: {
    $executeRaw: typeof prisma.$executeRaw;
    $queryRaw: typeof prisma.$queryRaw;
  },
  orgId: string,
): Promise<number> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${orgId + ":contact_number"}, 0))
  `;
  const rows = await tx.$queryRaw<Array<{ next: bigint | number | string }>>`
    SELECT COALESCE(MAX(number), 0) + 1 AS next
    FROM contacts
    WHERE "organizationId" = ${orgId}
  `;
  return Number(rows[0]?.next ?? 1);
}

/**
 * Compat: retorna o próximo número (com lock numa tx curta). Preferir
 * `insertContactWithNextNumber` / `createContact` para allocate+INSERT
 * na mesma transaction — senão ainda há janela entre return e create.
 */
export async function nextContactNumber(): Promise<number> {
  const orgId = getOrgIdOrThrow();
  return prisma.$transaction(async (tx) => allocateNextContactNumber(tx, orgId));
}

const CONTACT_NUMBER_MAX_RETRIES = 8;

function prismaUniqueMetaTarget(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as {
    code?: string;
    message?: string;
    meta?: { target?: string[] | string };
  };
  if (e.code !== "P2002") return "";
  const t = e.meta?.target;
  if (Array.isArray(t)) return t.map(String).join(",");
  if (typeof t === "string") return t;
  return typeof e.message === "string" ? e.message : "";
}

export function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

/** P2002 no unique (organizationId, number) — vale retry com novo número. */
export function isContactNumberUniqueViolation(err: unknown): boolean {
  if (!isPrismaUniqueViolation(err)) return false;
  const t = prismaUniqueMetaTarget(err);
  return (
    (/\bnumber\b/i.test(t) && /organizationId/i.test(t)) ||
    /organization_id_number/i.test(t)
  );
}

/** P2002 no unique de BSUID — não retry; reusar o contato existente. */
export function isContactBsuidUniqueViolation(err: unknown): boolean {
  if (!isPrismaUniqueViolation(err)) return false;
  const t = prismaUniqueMetaTarget(err);
  return /whatsapp_bsuid|whatsappBsuid/i.test(t);
}

/**
 * INSERT de contato alocando `number` sob advisory lock na mesma tx.
 * Retenta só colisão de número (com jitter). Outros P2002 (bsuid/phone/…)
 * sobem pro caller tratar (find + reusar).
 */
export async function insertContactWithNextNumber<T extends Prisma.ContactSelect>(
  fields: Omit<Prisma.ContactUncheckedCreateInput, "number" | "organizationId"> & {
    organizationId?: string;
  },
  select: T,
): Promise<Prisma.ContactGetPayload<{ select: T }>> {
  const orgId = getOrgIdOrThrow();
  let lastErr: unknown;
  for (let attempt = 0; attempt < CONTACT_NUMBER_MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const number = await allocateNextContactNumber(tx, orgId);
        return tx.contact.create({
          data: withOrgFromCtx({
            ...fields,
            number,
          }) as Prisma.ContactUncheckedCreateInput,
          select,
        });
      });
    } catch (err) {
      if (isContactNumberUniqueViolation(err)) {
        lastErr = err;
        const delayMs = 5 + Math.floor(Math.random() * 15 * (attempt + 1));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw (
    lastErr ??
    new Error(
      `insertContactWithNextNumber: max ${CONTACT_NUMBER_MAX_RETRIES} retries exceeded`,
    )
  );
}

export async function createContact(data: CreateContactInput) {
  const normalizedPhone = normalizeContactPhoneInput(data.phone);
  let lastErr: unknown;
  for (let attempt = 0; attempt < CONTACT_NUMBER_MAX_RETRIES; attempt++) {
    try {
      const orgId = getOrgIdOrThrow();
      const created = await prisma.$transaction(async (tx) => {
        const number = await allocateNextContactNumber(tx, orgId);
        return tx.contact.create({
          data: withOrgFromCtx({
            ...(data.id ? { id: data.id } : {}),
            number,
            name: sanitizeContactName(data.name) || data.name,
            externalId: data.externalId === undefined ? undefined : data.externalId,
            email: data.email ?? undefined,
            phone: normalizedPhone ?? undefined,
            avatarUrl: data.avatarUrl ?? undefined,
            leadScore: data.leadScore ?? undefined,
            lifecycleStage: data.lifecycleStage ?? undefined,
            source: data.source ?? undefined,
            companyId: data.companyId ?? undefined,
            assignedToId: data.assignedToId ?? undefined,
            ...(data.adUtmSource !== undefined ? { adUtmSource: data.adUtmSource } : {}),
            ...(data.adUtmMedium !== undefined ? { adUtmMedium: data.adUtmMedium } : {}),
            ...(data.adUtmCampaign !== undefined ? { adUtmCampaign: data.adUtmCampaign } : {}),
            ...(data.adUtmContent !== undefined ? { adUtmContent: data.adUtmContent } : {}),
            ...(data.adUtmTerm !== undefined ? { adUtmTerm: data.adUtmTerm } : {}),
            ...(data.utmId !== undefined ? { utmId: data.utmId } : {}),
            ...(data.utmReferrer !== undefined ? { utmReferrer: data.utmReferrer } : {}),
            ...(data.referrer !== undefined ? { referrer: data.referrer } : {}),
            ...(data.gclid !== undefined ? { gclid: data.gclid } : {}),
            ...(data.fbclid !== undefined ? { fbclid: data.fbclid } : {}),
            ...(data.googleClientId !== undefined
              ? { googleClientId: data.googleClientId }
              : {}),
            ...(data.ttadId !== undefined ? { ttadId: data.ttadId } : {}),
            ...(data.ttadName !== undefined ? { ttadName: data.ttadName } : {}),
          }),
          include: {
            company: { select: { id: true, number: true, name: true, domain: true } },
            tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
            assignedTo: { select: assignedToSelect },
          },
        });
      });

      void logEvent({
        type: "CONTACT_CREATED",
        entityType: "CONTACT",
        entityId: created.id,
        entityLabel: created.name ?? created.phone ?? created.email ?? null,
        contactId: created.id,
        meta: {
          email: created.email,
          phone: created.phone,
          source: data.source ?? null,
          createdAt: created.createdAt.toISOString(),
          name: created.name ?? created.phone ?? created.email,
        },
      });

      return created;
    } catch (err) {
      if (
        isContactNumberUniqueViolation(err) &&
        attempt < CONTACT_NUMBER_MAX_RETRIES - 1
      ) {
        lastErr = err;
        const delayMs = 5 + Math.floor(Math.random() * 15 * (attempt + 1));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Busca o id de um contato existente (na org atual) por telefone, tolerando
 * diferenças de formato e a ambiguidade do 9º dígito BR. Requer que os
 * telefones estejam gravados em E.164 (garantido por `createContact`/
 * `updateContact` + backfill `scripts/backfill-phone-e164.mjs`).
 */
export async function findContactIdByPhone(
  orgId: string,
  rawPhone: string | null | undefined,
): Promise<string | null> {
  const variants = phoneMatchVariants(rawPhone);
  if (variants.length === 0) return null;
  const c = await prisma.contact.findFirst({
    where: { organizationId: orgId, phone: { in: variants } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return c?.id ?? null;
}

export async function updateContact(id: string, data: UpdateContactInput) {
  // Unchecked: FKs escalares (`companyId`/`assignedToId`). Relação
  // `company: { connect }` + `organizationId` injetado pelo scope Prisma
  // mistura checked/unchecked e o update estoura 500.
  const updateData: Prisma.ContactUncheckedUpdateInput = {};

  // Snapshot anterior para diff (somente os campos que podem mudar).
  const prev = await prisma.contact.findUnique({
    where: { id },
    select: {
      name: true,
      email: true,
      phone: true,
      avatarUrl: true,
      leadScore: true,
      lifecycleStage: true,
      source: true,
      companyId: true,
      assignedToId: true,
      externalId: true,
    },
  });

  if (data.name !== undefined) {
    updateData.name = sanitizeContactName(data.name) || data.name;
  }
  if (data.email !== undefined) updateData.email = data.email;
  if (data.phone !== undefined) {
    updateData.phone = normalizeContactPhoneInput(data.phone) ?? null;
  }
  if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;
  if (data.leadScore !== undefined) updateData.leadScore = data.leadScore;
  if (data.lifecycleStage !== undefined) updateData.lifecycleStage = data.lifecycleStage;
  if (data.source !== undefined) updateData.source = data.source;
  if (data.companyId !== undefined) {
    updateData.companyId = data.companyId;
  }
  if (data.assignedToId !== undefined) {
    updateData.assignedToId = data.assignedToId;
  }
  if (data.externalId !== undefined) {
    updateData.externalId = data.externalId;
  }

  const trackingKeys = [
    "adUtmSource",
    "adUtmMedium",
    "adUtmCampaign",
    "adUtmContent",
    "adUtmTerm",
    "utmId",
    "utmReferrer",
    "referrer",
    "gclid",
    "fbclid",
    "googleClientId",
    "ttadId",
    "ttadName",
  ] as const;
  for (const key of trackingKeys) {
    if (data[key] !== undefined) {
      (updateData as Record<string, unknown>)[key] = data[key];
    }
  }

  const updated = await prisma.contact.update({
    where: { id },
    data: updateData,
    include: {
      company: { select: { id: true, number: true, name: true, domain: true } },
      tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
      assignedTo: { select: assignedToSelect },
    },
  });

  // Diff -> 1 evento por campo alterado.
  if (prev) {
    const NATIVE_FIELDS: Array<{ key: keyof typeof prev; label: string }> = [
      { key: "name", label: "Nome" },
      { key: "email", label: "Email" },
      { key: "phone", label: "Telefone" },
      { key: "leadScore", label: "Lead score" },
      { key: "lifecycleStage", label: "Estágio de ciclo" },
      { key: "source", label: "Origem" },
      { key: "companyId", label: "Empresa" },
      { key: "externalId", label: "ID externo" },
    ];
    for (const f of NATIVE_FIELDS) {
      const before = prev[f.key];
      const after = (updated as Record<string, unknown>)[f.key as string];
      if (before === after) continue;
      if (before == null && after == null) continue;
      void logEvent({
        type: "CONTACT_FIELD_CHANGED",
        entityType: "CONTACT",
        entityId: id,
        entityLabel: updated.name ?? updated.phone ?? updated.email ?? null,
        contactId: id,
        field: String(f.key),
        oldValue: before == null ? null : String(before),
        newValue: after == null ? null : String(after),
        meta: { field: String(f.key), label: f.label },
      });
    }
    // Mudanca de responsavel — evento dedicado.
    if (data.assignedToId !== undefined && prev.assignedToId !== data.assignedToId) {
      void logEvent({
        type: "CONTACT_OWNER_CHANGED",
        entityType: "CONTACT",
        entityId: id,
        entityLabel: updated.name ?? updated.phone ?? updated.email ?? null,
        contactId: id,
        field: "assignedToId",
        oldValue: prev.assignedToId,
        newValue: data.assignedToId ?? null,
        meta: { from: prev.assignedToId, to: data.assignedToId ?? null },
      });
      // Evento próprio (não reusa agent_changed — esse dispara automações de deal).
      void import("@/services/automation-triggers")
        .then(({ fireTrigger }) =>
          fireTrigger("contact_owner_changed", {
            contactId: id,
            data: {
              fromAssignedToId: prev.assignedToId,
              toAssignedToId: data.assignedToId ?? null,
            },
          }),
        )
        .catch(() => {});
    }
  }

  return updated;
}

export async function checkContactDeals(id: string): Promise<{ hasDeals: boolean; dealCount: number }> {
  const dealCount = await prisma.deal.count({ where: { contactId: id } });
  return { hasDeals: dealCount > 0, dealCount };
}

/**
 * Remove o contato e todas as relações que não estão marcadas como
 * onDelete: Cascade no schema. As que SÃO Cascade (TagOnContact,
 * ContactCustomFieldValue, AutomationContext, ScheduledWhatsappCall,
 * CampaignRecipient, ContactPhoneChange) caem junto pelo próprio banco.
 *
 * Pressupõe que o caller já checou que não há deals abertos (endpoint
 * usa `checkContactDeals`). Se mesmo assim um deal estiver apontando
 * para esse contato, nulificamos a FK em vez de deletar o deal.
 */
export async function deleteContact(id: string) {
  await prisma.$transaction(async (tx) => {
    const convs = await tx.conversation.findMany({
      where: { contactId: id },
      select: { id: true },
    });
    if (convs.length > 0) {
      const convIds = convs.map((c) => c.id);
      await tx.message.deleteMany({ where: { conversationId: { in: convIds } } });
      await tx.conversation.deleteMany({ where: { id: { in: convIds } } });
    }

    await tx.activity.deleteMany({ where: { contactId: id } });
    await tx.note.deleteMany({ where: { contactId: id } });
    await tx.automationLog.deleteMany({ where: { contactId: id } });

    await tx.deal.updateMany({
      where: { contactId: id },
      data: { contactId: null },
    });

    await tx.whatsappCallEvent.updateMany({
      where: { contactId: id },
      data: { contactId: null },
    });

    await tx.contact.delete({ where: { id } });
  });
}

type ActivityWithRelations = Awaited<
  ReturnType<
    typeof prisma.activity.findMany<{
      include: {
        user: { select: typeof assignedToSelect };
        deal: { select: { id: true; title: true } };
      };
    }>
  >
>[number];

type NoteWithUser = Awaited<
  ReturnType<
    typeof prisma.note.findMany<{
      include: { user: { select: typeof assignedToSelect } };
    }>
  >
>[number];

type DealTimelinePayload = Omit<
  Awaited<
    ReturnType<
      typeof prisma.deal.findMany<{
        include: {
          stage: { select: { id: true; name: true; color: true } };
          owner: { select: typeof assignedToSelect };
        };
      }>
    >
  >[number],
  "value"
> & { value: string };

export type TimelineItem =
  | { kind: "activity"; at: Date; activity: ActivityWithRelations }
  | { kind: "note"; at: Date; note: NoteWithUser }
  | { kind: "deal"; at: Date; event: "created" | "updated" | "closed"; deal: DealTimelinePayload };

export async function getContactTimeline(contactId: string): Promise<TimelineItem[]> {
  const [activities, notes, deals] = await Promise.all([
    prisma.activity.findMany({
      where: { contactId },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: assignedToSelect },
        deal: { select: { id: true, title: true } },
      },
    }),
    prisma.note.findMany({
      where: { contactId },
      orderBy: { createdAt: "desc" },
      include: { user: { select: assignedToSelect } },
    }),
    prisma.deal.findMany({
      where: { contactId },
      orderBy: { updatedAt: "desc" },
      include: {
        stage: { select: { id: true, name: true, color: true } },
        owner: { select: assignedToSelect },
      },
    }),
  ]);

  const items: TimelineItem[] = [];

  for (const activity of activities) {
    const at = activity.scheduledAt ?? activity.completedAt ?? activity.createdAt;
    items.push({ kind: "activity", at, activity });
  }

  for (const note of notes) {
    items.push({ kind: "note", at: note.createdAt, note });
  }

  for (const deal of deals) {
    const base = { ...deal, value: dealValueToString(deal.value) };
    items.push({ kind: "deal", at: deal.createdAt, event: "created", deal: base });
    if (deal.updatedAt.getTime() !== deal.createdAt.getTime()) {
      items.push({ kind: "deal", at: deal.updatedAt, event: "updated", deal: base });
    }
    if (deal.closedAt) {
      items.push({ kind: "deal", at: deal.closedAt, event: "closed", deal: base });
    }
  }

  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return items;
}
