/**
 * Ferramentas MCP (somente leitura). Cada uma espelha a rota de sessão
 * equivalente da UI e reaproveita os MESMOS serviços e filtros:
 *
 *   list_leads                 → GET /api/deals            (getDeals)
 *   get_lead                   → GET /api/deals/[id]       (getDealById + timeline)
 *   list_conversations         → GET /api/conversations    (getConversations)
 *   get_conversation_messages  → GET /api/conversations/[id]/messages
 *   get_sales_metrics          → GET /api/dashboard        (getDashboard)
 *   get_team_performance       → GET /api/dashboard byOwner (gestor/admin)
 *   get_campaign_results       → GET /api/campaigns[/id/stats]
 *   get_pipeline_metrics       → GET /api/dashboard funnel (getDashboard)
 *
 * Diferenças deliberadas (sempre MAIS restritivas que a UI):
 *   - métricas exigem `report:view`; quem não vê todos os negócios recebe
 *     só os próprios (ownerIds = [userId]); funis fora do escopo do
 *     usuário (allow-list por usuário + deny por papel) ficam de fora;
 *   - histórico do lead não traz eventos de mensagem (escopo próprio);
 *   - mensagens internas (isPrivate) não saem; telefone/e-mail saem
 *     mascarados salvo `exposeContactPii` da organização;
 *   - campos personalizados não saem (máscara por campo é por papel).
 *
 * Roda dentro de `runWithContext` com `isSuperAdmin: false` — o client
 * Prisma escopado injeta a organização da conexão em toda consulta.
 */
import { loadAuthzContext, canViewStage } from "@/lib/authz";
import { andDealWhere, funnelDealWhere, funnelScopeOf } from "@/lib/authz/funnel-visibility";
import {
  canViewFieldForUser,
  listAllowedPipelineIds,
  requirePipelineScope,
  requireStageScope,
} from "@/lib/authz/resource-policy";
import { maskEmail, maskPhone } from "@/lib/pii-mask";
import { prisma } from "@/lib/prisma";
import {
  canSeeDealByOwner,
  getVisibilityFilter,
  hasAssignedConversationWithContact,
} from "@/lib/visibility";
import { getCampaignById, getCampaignStats, getCampaigns } from "@/services/campaigns";
import { getDashboard, type DashboardFilters } from "@/services/dashboard";
import { getDealById, getDeals } from "@/services/deals";
import type { Prisma } from "@prisma/client";
import { computePainelRange } from "@/services/painel-period";

import {
  canSeeTracking,
  hasTrackingFilter,
  loadTracking,
  salesByCampaign,
  trackingDealWhere,
  type TrackingFilterArgs,
} from "./tools-tracking";

export type ToolUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
  organizationId: string;
  isSuperAdmin: false;
};

/**
 * `ownOnly`: operador (quem não é admin nem gestor) só enxerga, pelo MCP, o
 * que é dele — negócios em que é o responsável e as conversas atribuídas a
 * ele ou de contatos desses negócios. Vale mesmo que a org libere ao papel
 * "ver todos" ou o pool sem responsável na UI. Admin e gestor seguem a
 * visibilidade que já têm no CRM.
 */
export type ToolEnv = {
  user: ToolUser;
  exposeContactPii: boolean;
  ownOnly: boolean;
  /** Escopos efetivos da chamada (conexão ∩ org): liga recursos opcionais. */
  scopes: readonly McpScope[];
  /** Campos personalizados liberados pela org (`custom_fields:read`). */
  customFieldIds: readonly string[];
};

export { isMcpOwnScopeOnly } from "@/lib/mcp/scopes";
import type { McpScope } from "@/lib/mcp/scopes";

/** Conversas "do operador": atribuídas a ele ou de contato com negócio dele. */
export function ownConversationWhere(userId: string): Prisma.ConversationWhereInput {
  return {
    OR: [{ assignedToId: userId }, { contact: { deals: { some: { ownerId: userId } } } }],
  };
}

export const OWN_ONLY_DENIED = "Disponível só para gestores e administradores. Pelo assistente você consulta os seus negócios e conversas.";

/** Erro de negócio esperado (acesso negado, não encontrado, filtro inválido). */
export class ToolError extends Error {
  constructor(
    public readonly code: "forbidden" | "not_found" | "invalid_argument",
    message: string,
  ) {
    super(message);
  }
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function contactOut(
  env: ToolEnv,
  c: { id: string; name?: string | null; email?: string | null; phone?: string | null } | null | undefined,
) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name ?? null,
    email: c.email ? (env.exposeContactPii ? c.email : maskEmail(c.email)) : null,
    phone: c.phone ? (env.exposeContactPii ? c.phone : maskPhone(c.phone)) : null,
  };
}

export function truncate(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function authzOf(user: ToolUser) {
  return loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: false,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Campos personalizados (escopo `custom_fields:read` + lista da org)
// ──────────────────────────────────────────────────────────────────────

export type CustomFieldOut = { field: string; entity: "deal" | "contact"; value: string };

/**
 * Valores dos campos personalizados liberados pela org para os negócios
 * pedidos. `null` = recurso desligado (sem escopo ou lista vazia).
 * Campo que o papel do usuário não pode ver (máscara por papel) não sai;
 * telefone/e-mail seguem o toggle de PII da org.
 */
export async function loadAllowedCustomFields(
  env: ToolEnv,
  deals: { id: string; contactId: string | null }[],
): Promise<Map<string, CustomFieldOut[]> | null> {
  if (!env.scopes.includes("custom_fields:read") || env.customFieldIds.length === 0) return null;
  const out = new Map<string, CustomFieldOut[]>();
  if (deals.length === 0) return out;
  const fields = await prisma.customField.findMany({
    where: { id: { in: [...env.customFieldIds] }, entity: { in: ["deal", "contact"] } },
    select: { id: true, label: true, name: true, entity: true, type: true },
  });
  const visible: typeof fields = [];
  for (const f of fields) {
    if (await canViewFieldForUser(env.user, f.entity as "deal" | "contact", f.id)) visible.push(f);
  }
  if (visible.length === 0) return out;
  const byId = new Map(visible.map((f) => [f.id, f]));
  const dealFieldIds = visible.filter((f) => f.entity === "deal").map((f) => f.id);
  const contactFieldIds = visible.filter((f) => f.entity === "contact").map((f) => f.id);
  const contactIds = [...new Set(deals.map((d) => d.contactId).filter((v): v is string => Boolean(v)))];
  const [dealValues, contactValues] = await Promise.all([
    dealFieldIds.length
      ? prisma.dealCustomFieldValue.findMany({
          where: { dealId: { in: deals.map((d) => d.id) }, customFieldId: { in: dealFieldIds } },
          select: { dealId: true, customFieldId: true, value: true },
        })
      : Promise.resolve([]),
    contactFieldIds.length && contactIds.length
      ? prisma.contactCustomFieldValue.findMany({
          where: { contactId: { in: contactIds }, customFieldId: { in: contactFieldIds } },
          select: { contactId: true, customFieldId: true, value: true },
        })
      : Promise.resolve([]),
  ]);
  const shown = (fieldId: string, raw: string): CustomFieldOut | null => {
    const f = byId.get(fieldId);
    if (!f || !raw?.trim()) return null;
    let value = raw.length > 1000 ? `${raw.slice(0, 1000)}…` : raw;
    if (!env.exposeContactPii && f.type === "PHONE") value = maskPhone(value);
    if (!env.exposeContactPii && f.type === "EMAIL") value = maskEmail(value);
    return { field: f.label || f.name, entity: f.entity as "deal" | "contact", value };
  };
  const contactMap = new Map<string, CustomFieldOut[]>();
  for (const v of contactValues) {
    const o = shown(v.customFieldId, v.value);
    if (o) contactMap.set(v.contactId, [...(contactMap.get(v.contactId) ?? []), o]);
  }
  for (const d of deals) {
    const own = dealValues
      .filter((v) => v.dealId === d.id)
      .map((v) => shown(v.customFieldId, v.value))
      .filter((v): v is CustomFieldOut => v !== null);
    out.set(d.id, [...own, ...(d.contactId ? (contactMap.get(d.contactId) ?? []) : [])]);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Leads (Deal)
// ──────────────────────────────────────────────────────────────────────

export type ListLeadsArgs = {
  pipelineId?: string;
  stageId?: string;
  status?: "OPEN" | "WON" | "LOST";
  ownerId?: string;
  search?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  perPage?: number;
} & TrackingFilterArgs;

const TRACKING_DENIED =
  "Filtros e dados de rastreio (UTM, campanha, anúncio) são só para gestores e administradores, com a permissão \"tracking:read\" liberada na conexão.";

export async function listLeads(env: ToolEnv, args: ListLeadsArgs) {
  // Rastreio é só de admin/gestor com o escopo: operador nunca filtra por campanha.
  if (hasTrackingFilter(args) && !canSeeTracking(env)) {
    throw new ToolError("forbidden", TRACKING_DENIED);
  }
  const { user } = env;
  const [visibility, authz] = await Promise.all([getVisibilityFilter(user), authzOf(user)]);
  if (args.pipelineId && (await requirePipelineScope(user, "view", args.pipelineId))) {
    throw new ToolError("forbidden", "Sem acesso a este funil.");
  }
  if (args.stageId && (await requireStageScope(user, "view", args.stageId))) {
    throw new ToolError("forbidden", "Sem acesso a esta etapa.");
  }
  const allowedPipelineIds = await listAllowedPipelineIds(user);
  const createdAt =
    args.createdFrom || args.createdTo
      ? { from: args.createdFrom ?? null, to: args.createdTo ?? null }
      : undefined;
  const perPage = Math.min(50, Math.max(1, args.perPage ?? 20));
  const page = Math.min(500, Math.max(1, args.page ?? 1));
  const result = await getDeals({
    pipelineId: args.pipelineId,
    stageId: args.stageId,
    status: args.status,
    ownerId: args.ownerId === "me" ? user.id : args.ownerId,
    search: args.search?.slice(0, 100),
    page,
    perPage,
    // Operador: só negócios em que é o responsável (sem pool nem "ver todos").
    visibilityWhere: andDealWhere(
      andDealWhere(
        env.ownOnly ? { ownerId: user.id } : visibility.dealWhere,
        funnelDealWhere(authz),
      ),
      trackingDealWhere(args),
    ),
    allowedPipelineIds,
    advancedFilters: createdAt ? { createdAt } : undefined,
  });
  const [custom, tracking] = await Promise.all([
    loadAllowedCustomFields(
      env,
      result.items.map((d) => ({ id: d.id, contactId: d.contactId ?? null })),
    ),
    loadTracking(env, result.items.map((d) => d.contactId)),
  ]);
  return {
    scope: env.ownOnly ? "own" : "visible",
    page: result.page,
    perPage: result.perPage,
    total: result.total,
    hasMore: result.hasMore,
    items: result.items.map((d) => ({
      id: d.id,
      number: d.number,
      title: d.title,
      value: num(d.value),
      status: d.status,
      pipeline: d.stage?.pipeline ? { id: d.stage.pipeline.id, name: d.stage.pipeline.name } : null,
      stage: d.stage ? { id: d.stage.id, name: d.stage.name } : null,
      owner: d.owner ? { id: d.owner.id, name: d.owner.name } : null,
      contact: contactOut(env, d.contact),
      source: d.contact?.source ?? null,
      tags: (d.tags ?? []).map((t) => t.tag.name),
      expectedClose: iso(d.expectedClose),
      lostReason: d.lostReason ?? null,
      createdAt: iso(d.createdAt),
      updatedAt: iso(d.updatedAt),
      ...(custom ? { customFields: custom.get(d.id) ?? [] } : {}),
      ...(tracking ? { tracking: (d.contactId ? tracking.get(d.contactId) : null) ?? null } : {}),
    })),
  };
}

export async function getLead(env: ToolEnv, args: { id: string }) {
  const { user } = env;
  // Número fora do int4 estoura no Prisma (getDealById não limita).
  if (/^\d+$/.test(args.id) && Number(args.id) > 2_147_483_647) {
    throw new ToolError("not_found", "Lead não encontrado.");
  }
  const deal = await getDealById(args.id);
  if (!deal) throw new ToolError("not_found", "Lead não encontrado.");
  const pipelineId = deal.stage.pipeline?.id ?? "";
  const [stageDenied, pipelineDenied, authz, visibility] = await Promise.all([
    requireStageScope(user, "view", deal.stage.id),
    pipelineId ? requirePipelineScope(user, "view", pipelineId) : Promise.resolve(null),
    authzOf(user),
    getVisibilityFilter(user),
  ]);
  if (stageDenied || pipelineDenied) throw new ToolError("forbidden", "Sem acesso a este lead.");
  if (env.ownOnly) {
    if (deal.ownerId !== user.id) {
      throw new ToolError("forbidden", "Este lead não está sob sua responsabilidade.");
    }
  } else if (
    !canSeeDealByOwner(visibility, user.id, deal.ownerId ?? null) &&
    !(await hasAssignedConversationWithContact(user.id, deal.contactId))
  ) {
    throw new ToolError("forbidden", "Sem acesso a este lead.");
  }

  const stageNames = new Map<string, string>();
  for (const s of deal.stage.pipeline?.stages ?? []) {
    if (canViewStage(authz, s.id)) stageNames.set(s.id, s.name);
  }

  // Mesmo recorte da timeline do negócio, sem eventos de mensagem (o
  // conteúdo das conversas exige o escopo `messages:read`).
  const contactScopedTypes = ["CONTACT_CREATED", "CONTACT_TAG_ADDED", "CONTACT_TAG_REMOVED", "CONTACT_FIELD_CHANGED"];
  const events = await prisma.activityEvent.findMany({
    where: {
      AND: [
        deal.contactId
          ? { OR: [{ dealId: deal.id }, { contactId: deal.contactId, type: { in: contactScopedTypes } }] }
          : { dealId: deal.id },
        { NOT: { type: { startsWith: "MESSAGE" } } },
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      type: true,
      occurredAt: true,
      fromStageId: true,
      toStageId: true,
      actorType: true,
      actorLabel: true,
      actorUser: { select: { name: true } },
    },
  });
  const notes = await prisma.note.findMany({
    where: { dealId: deal.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { content: true, createdAt: true, user: { select: { name: true } } },
  });

  const contact = deal.contact as
    | { id: string; name: string | null; email: string | null; phone: string | null; source?: string | null; tags?: { tag: { name: string } }[] }
    | null;
  const conversations = (deal.contact as { conversations?: { id: string; number?: number; status: string; channel: string }[] } | null)
    ?.conversations ?? [];
  return {
    id: deal.id,
    number: deal.number,
    title: deal.title,
    value: num(deal.value),
    status: deal.status,
    lostReason: deal.lostReason ?? null,
    expectedClose: iso(deal.expectedClose),
    pipeline: deal.stage.pipeline ? { id: deal.stage.pipeline.id, name: deal.stage.pipeline.name } : null,
    stage: { id: deal.stage.id, name: deal.stage.name },
    owner: deal.owner ? { id: deal.owner.id, name: deal.owner.name } : null,
    contact: contactOut(env, contact),
    source: contact?.source ?? null,
    tags: ((deal as { tags?: { tag: { name: string } }[] }).tags ?? []).map((t) => t.tag.name),
    createdAt: iso(deal.createdAt),
    updatedAt: iso(deal.updatedAt),
    ...(await (async () => {
      const custom = await loadAllowedCustomFields(env, [{ id: deal.id, contactId: deal.contactId ?? null }]);
      return custom ? { customFields: custom.get(deal.id) ?? [] } : {};
    })()),
    ...(await (async () => {
      const tracking = await loadTracking(env, [deal.contactId]);
      return tracking ? { tracking: (deal.contactId ? tracking.get(deal.contactId) : null) ?? null } : {};
    })()),
    conversations: conversations.slice(0, 10).map((c) => ({
      id: c.id,
      number: c.number ?? null,
      status: c.status,
      channel: c.channel,
    })),
    history: events.map((e) => ({
      type: e.type,
      at: iso(e.occurredAt),
      actor: e.actorUser?.name ?? e.actorLabel ?? e.actorType,
      ...(e.fromStageId || e.toStageId
        ? {
            fromStage: e.fromStageId ? (stageNames.get(e.fromStageId) ?? "(etapa restrita)") : null,
            toStage: e.toStageId ? (stageNames.get(e.toStageId) ?? "(etapa restrita)") : null,
          }
        : {}),
    })),
    notes: notes.map((n) => ({
      at: iso(n.createdAt),
      author: n.user?.name ?? null,
      content: truncate(n.content, 1000),
    })),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Conversas
// ──────────────────────────────────────────────────────────────────────

// list_conversations, get_conversation_messages, get_conversation_events,
// get_queue_status e get_team_performance: `tools-conversations.ts`.

// ──────────────────────────────────────────────────────────────────────
// Métricas (dashboard)
// ──────────────────────────────────────────────────────────────────────

export type PeriodArgs = {
  period?: "today" | "yesterday" | "last_7" | "last_30" | "this_month" | "last_month" | "custom";
  startDate?: string;
  endDate?: string;
};

export function resolvePeriod(args: PeriodArgs): { from: Date; to: Date } {
  const period = args.period ?? "last_30";
  if (period === "custom" && (!args.startDate || !args.endDate)) {
    throw new ToolError("invalid_argument", "period=custom exige startDate e endDate (YYYY-MM-DD).");
  }
  const range = computePainelRange(period, args.startDate ?? null, args.endDate ?? null);
  if (range.to.getTime() - range.from.getTime() > 366 * 24 * 3600 * 1000) {
    throw new ToolError("invalid_argument", "Período máximo: 366 dias.");
  }
  return range;
}

/**
 * Filtros do dashboard SEM ampliar o que o usuário vê:
 *   - deny de funil/etapa por papel (igual a `/api/dashboard`);
 *   - funis fora da allow-list por usuário ficam excluídos;
 *   - quem não vê todos os negócios só recebe os próprios.
 * `null` = nada visível (funil pedido está fora do escopo).
 */
export async function scopedDashboardFilters(
  user: ToolUser,
  pipelineId: string,
  ownOnly: boolean,
): Promise<Omit<DashboardFilters, "from" | "to" | "pipelineId"> | null> {
  const [authz, visibility, allowedPipelineIds] = await Promise.all([
    authzOf(user),
    getVisibilityFilter(user),
    listAllowedPipelineIds(user),
  ]);
  const funnel = funnelScopeOf(authz);
  const excludePipelineIds = new Set(funnel?.denyPipelineIds ?? []);
  if (allowedPipelineIds) {
    const all = await prisma.pipeline.findMany({ where: { archivedAt: null }, select: { id: true } });
    for (const p of all) if (!allowedPipelineIds.includes(p.id)) excludePipelineIds.add(p.id);
  }
  if (pipelineId && excludePipelineIds.has(pipelineId)) return null;
  return {
    excludePipelineIds: [...excludePipelineIds],
    excludeStageIds: funnel?.denyStageIds,
    allowStageIds: funnel?.allowStageIds ?? undefined,
    ownerIds: visibility.canSeeAll && !ownOnly ? undefined : [user.id],
  };
}

export async function resolvePipelineArg(pipelineId: string | undefined): Promise<string> {
  if (!pipelineId) return "";
  const p = await prisma.pipeline.findFirst({
    where: /^\d+$/.test(pipelineId) ? { number: Number(pipelineId), archivedAt: null } : { id: pipelineId, archivedAt: null },
    select: { id: true },
  });
  if (!p) throw new ToolError("not_found", "Funil não encontrado.");
  return p.id;
}

export async function getSalesMetrics(env: ToolEnv, args: PeriodArgs & { pipelineId?: string }) {
  const { user } = env;
  const range = resolvePeriod(args);
  const pipelineId = await resolvePipelineArg(args.pipelineId);
  if (pipelineId && (await requirePipelineScope(user, "view", pipelineId))) {
    throw new ToolError("forbidden", "Sem acesso a este funil.");
  }
  const scoped = await scopedDashboardFilters(user, pipelineId, env.ownOnly);
  if (!scoped) throw new ToolError("forbidden", "Sem acesso a este funil.");
  const [data, campaigns] = await Promise.all([
    getDashboard({ from: range.from, to: range.to, pipelineId, ...scoped }),
    // Campanha/anúncio: só admin/gestor com `tracking:read`.
    canSeeTracking(env)
      ? salesByCampaign(user.organizationId, range, pipelineId, scoped)
      : Promise.resolve(null),
  ]);
  return {
    period: { from: iso(range.from), to: iso(range.to) },
    pipelineId: pipelineId || "all",
    onlyOwnDeals: Boolean(scoped.ownerIds),
    summary: data.summary,
    newDeals: data.newDeals,
    bySource: data.bySource.slice(0, 20),
    ...(campaigns
      ? { byCampaign: campaigns.byCampaign, byAd: campaigns.byAd, byCampaignBasis: "negócios criados no período" }
      : {}),
    lossReasons: data.lossReasons.slice(0, 20),
    dailyEvolution: data.dailyEvolution,
  };
}

export async function getPipelineMetrics(env: ToolEnv, args: PeriodArgs & { pipelineId: string }) {
  const { user } = env;
  const range = resolvePeriod(args);
  const pipelineId = await resolvePipelineArg(args.pipelineId);
  if (!pipelineId) throw new ToolError("invalid_argument", "pipelineId é obrigatório.");
  if (await requirePipelineScope(user, "view", pipelineId)) {
    throw new ToolError("forbidden", "Sem acesso a este funil.");
  }
  const scoped = await scopedDashboardFilters(user, pipelineId, env.ownOnly);
  if (!scoped) throw new ToolError("forbidden", "Sem acesso a este funil.");
  const data = await getDashboard({ from: range.from, to: range.to, pipelineId, ...scoped });
  return {
    period: { from: iso(range.from), to: iso(range.to) },
    pipelineId,
    onlyOwnDeals: Boolean(scoped.ownerIds),
    stages: data.funnel.map((s) => ({
      id: s.id,
      name: s.name,
      openCount: s.count,
      openValue: s.value,
      entered: s.entered,
      exited: s.exited,
      won: s.won,
      lost: s.lost,
      conversion: s.conversion,
    })),
    stalled: data.stalled,
    summary: {
      openDeals: data.summary.openDeals,
      totalValue: data.summary.totalValue,
      winRate: data.summary.winRate,
      wonCount: data.summary.wonCount,
      lostCount: data.summary.lostCount,
    },
  };
}

/** Funis visíveis (apoio às métricas: o modelo precisa dos IDs). */
export async function listVisiblePipelines(env: ToolEnv) {
  const { user } = env;
  const [authz, allowed] = await Promise.all([authzOf(user), listAllowedPipelineIds(user)]);
  const deny = new Set(funnelScopeOf(authz)?.denyPipelineIds ?? []);
  const rows = await prisma.pipeline.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, number: true, name: true },
  });
  return rows.filter((p) => !deny.has(p.id) && (!allowed || allowed.includes(p.id)));
}

// ──────────────────────────────────────────────────────────────────────
// Campanhas
// ──────────────────────────────────────────────────────────────────────

export async function getCampaignResults(
  env: ToolEnv,
  args: { campaignId?: string; status?: string; search?: string; page?: number; perPage?: number },
) {
  // Campanha é da org inteira, não de um vendedor.
  if (env.ownOnly) throw new ToolError("forbidden", OWN_ONLY_DENIED);
  if (args.campaignId) {
    const campaign = await getCampaignById(args.campaignId);
    if (!campaign) throw new ToolError("not_found", "Campanha não encontrada.");
    const stats = await getCampaignStats(campaign.id);
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        type: campaign.type,
        channel: campaign.channel ? campaign.channel.name : null,
        segment: campaign.segment ? campaign.segment.name : null,
        createdAt: iso(campaign.createdAt),
      },
      stats: {
        totalRecipients: stats.totalRecipients,
        sent: stats.sentCount,
        delivered: stats.deliveredCount,
        read: stats.readCount,
        replied: stats.repliedCount,
        failed: stats.failedCount,
        pending: stats.pendingCount,
        deliveryRate: stats.deliveryRate,
        readRate: stats.readRate,
        replyRate: stats.replyRate,
        startedAt: iso(stats.startedAt),
        completedAt: iso(stats.completedAt),
        failureReasons: (stats.failureReasons ?? []).slice(0, 10).map((f) => ({ reason: f.reason, count: f.count })),
      },
    };
  }
  const list = await getCampaigns({
    status: args.status as never,
    search: args.search?.slice(0, 100),
    page: Math.max(1, args.page ?? 1),
    perPage: Math.min(50, Math.max(1, args.perPage ?? 20)),
  });
  return {
    page: list.page,
    perPage: list.perPage,
    total: list.total,
    totalPages: list.totalPages,
    items: list.items.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      type: c.type,
      channel: c.channel ? c.channel.name : null,
      segment: c.segment ? c.segment.name : null,
      totalRecipients: c.totalRecipients,
      sent: c.sentCount,
      delivered: c.deliveredCount,
      read: c.readCount,
      replied: c.repliedCount,
      failed: c.failedCount,
      createdAt: iso(c.createdAt),
      startedAt: iso(c.startedAt),
      completedAt: iso(c.completedAt),
    })),
  };
}

export function countOf(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const k of ["items", "messages", "events", "attendants", "departments", "sellers", "stages"]) {
    if (Array.isArray(r[k])) return (r[k] as unknown[]).length;
  }
  return 1;
}
