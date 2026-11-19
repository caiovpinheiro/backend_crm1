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
import {
  andConversationWhere,
  andDealWhere,
  conversationFunnelWhere,
  funnelDealWhere,
  funnelScopeOf,
} from "@/lib/authz/funnel-visibility";
import { scopeGrantsOnce } from "@/lib/authz/request-prechecks";
import {
  canDoChannelAction,
  listAllowedChannelIds,
  listAllowedPipelineIds,
  requirePipelineScope,
  requireStageScope,
} from "@/lib/authz/resource-policy";
import { canSeeInboxTab } from "@/lib/authz/scope-grants";
import { resolveConversationId, userHasConversationAccess } from "@/lib/conversation-access";
import { maskEmail, maskPhone } from "@/lib/pii-mask";
import { prisma } from "@/lib/prisma";
import { createRequestMemo } from "@/lib/request-memo";
import {
  canSeeDealByOwner,
  getVisibilityFilter,
  hasAssignedConversationWithContact,
  withInboxQueueVisibility,
} from "@/lib/visibility";
import { getCampaignById, getCampaignStats, getCampaigns } from "@/services/campaigns";
import {
  getConversations,
  INBOX_CATEGORY_TABS,
  type InboxCategoryTab,
} from "@/services/conversations";
import { InvalidListCursorError } from "@/services/conversation-list-cursor";
import { getDashboard, type DashboardFilters } from "@/services/dashboard";
import { getDealById, getDeals } from "@/services/deals";
import { computePainelRange } from "@/services/painel-period";

export type ToolUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
  organizationId: string;
  isSuperAdmin: false;
};

export type ToolEnv = { user: ToolUser; exposeContactPii: boolean };

/** Erro de negócio esperado (acesso negado, não encontrado, filtro inválido). */
export class ToolError extends Error {
  constructor(
    public readonly code: "forbidden" | "not_found" | "invalid_argument",
    message: string,
  ) {
    super(message);
  }
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function contactOut(
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

function truncate(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function authzOf(user: ToolUser) {
  return loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: false,
  });
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
};

export async function listLeads(env: ToolEnv, args: ListLeadsArgs) {
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
    visibilityWhere: andDealWhere(visibility.dealWhere, funnelDealWhere(authz)),
    allowedPipelineIds,
    advancedFilters: createdAt ? { createdAt } : undefined,
  });
  return {
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
  if (
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

export type ListConversationsArgs = {
  status?: "OPEN" | "RESOLVED" | "PENDING" | "SNOOZED";
  channel?: string;
  ownerId?: string;
  search?: string;
  contactId?: string;
  cursor?: string;
  perPage?: number;
};

export async function listConversations(env: ToolEnv, args: ListConversationsArgs) {
  const { user } = env;
  const memo = createRequestMemo();
  const [grants, allowedChannelIds, authz, visibility] = await Promise.all([
    scopeGrantsOnce(memo, user.organizationId),
    listAllowedChannelIds(user, memo),
    authzOf(user),
    getVisibilityFilter(user, { memo }),
  ]);
  const inboxPerms: ReadonlySet<string> = authz.isAdmin ? new Set(["*"]) : authz.permissions;
  // Mesma regra da aba "Todos" da inbox: MEMBER só vê as filas liberadas.
  const canTodos = canSeeInboxTab({ grants, role: user.role, tab: "todos", permissions: inboxPerms });
  const categoryTabs = INBOX_CATEGORY_TABS.filter((t) =>
    canSeeInboxTab({ grants, role: user.role, tab: t, permissions: inboxPerms }),
  ) as InboxCategoryTab[];
  const memberTabs: InboxCategoryTab[] =
    categoryTabs.length > 0 ? categoryTabs : ["esperando", "respondidas"];

  const conversationWhere = andConversationWhere(
    withInboxQueueVisibility(visibility.conversationWhere, {
      permissions: inboxPerms,
      includeUnassigned: visibility.includeUnassigned,
    }),
    conversationFunnelWhere(authz),
  );

  let result;
  try {
    result = await getConversations({
      status: args.status,
      channel: args.channel,
      ownerId: args.ownerId === "me" ? user.id : args.ownerId,
      contactId: args.contactId,
      search: args.search?.slice(0, 100),
      tab: canTodos ? "todos" : memberTabs,
      todosCategoryTabs: canTodos && user.role === "MEMBER" ? memberTabs : undefined,
      cursor: args.cursor,
      perPage: Math.min(50, Math.max(1, args.perPage ?? 20)),
      visibilityWhere: conversationWhere,
      allowedChannelIds,
    });
  } catch (err) {
    if (err instanceof InvalidListCursorError) {
      throw new ToolError("invalid_argument", "cursor inválido.");
    }
    throw err;
  }
  return {
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    items: result.items.map((c) => ({
      id: c.id,
      number: c.number,
      status: c.status,
      channel: c.channel,
      unreadCount: c.unreadCount,
      contact: contactOut(env, c.contact),
      assignedTo: c.assignedTo ? { id: c.assignedTo.id, name: c.assignedTo.name } : null,
      department: c.department ? c.department.name : null,
      lastMessageAt: iso(c.lastMessageAt),
      lastMessageDirection: c.lastMessageDirection ?? null,
      createdAt: iso(c.createdAt),
      closedAt: iso(c.closedAt),
      tags: (c.tags ?? []).map((t) => t.name),
    })),
  };
}

export async function getConversationMessages(
  env: ToolEnv,
  args: { conversationId: string; before?: string; limit?: number },
) {
  const { user } = env;
  const conversationId = await resolveConversationId(args.conversationId);
  if (!conversationId) throw new ToolError("not_found", "Conversa não encontrada.");
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId },
    select: { id: true, number: true, channel: true, channelId: true, status: true, contact: { select: { id: true, name: true, email: true, phone: true } } },
  });
  if (!conv) throw new ToolError("not_found", "Conversa não encontrada.");
  // Mesma decisão do inbox (dono, deal do contato, fila/visibilidade + canal,
  // funil) e o escopo de leitura do canal.
  const allowed =
    (await userHasConversationAccess(user, conv.id)) &&
    (await canDoChannelAction(user, "view", conv.channelId));
  if (!allowed) throw new ToolError("forbidden", "Sem acesso a esta conversa.");

  let before: Date | undefined;
  if (args.before) {
    before = new Date(args.before);
    if (Number.isNaN(before.getTime())) throw new ToolError("invalid_argument", "before inválido (ISO-8601).");
  }
  const limit = Math.min(50, Math.max(1, args.limit ?? 30));
  const rows = await prisma.message.findMany({
    where: {
      conversationId: conv.id,
      isPrivate: false,
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      direction: true,
      messageType: true,
      content: true,
      authorType: true,
      senderName: true,
      sendStatus: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    conversation: {
      id: conv.id,
      number: conv.number,
      channel: conv.channel,
      status: conv.status,
      contact: contactOut(env, conv.contact),
    },
    hasMore,
    nextBefore: hasMore ? iso(page[page.length - 1]?.createdAt) : null,
    // Ordem cronológica (mais antiga primeiro) — leitura natural para o modelo.
    messages: page.reverse().map((m) => ({
      id: m.id,
      at: iso(m.createdAt),
      direction: m.direction,
      author: m.direction === "in" ? "contato" : (m.senderName ?? String(m.authorType)),
      authorType: String(m.authorType),
      type: m.messageType,
      text: m.messageType === "text" || m.content.length < 4000 ? truncate(m.content, 4000) : `[${m.messageType}]`,
      status: m.sendStatus,
    })),
  };
}

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
async function scopedDashboardFilters(
  user: ToolUser,
  pipelineId: string,
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
    ownerIds: visibility.canSeeAll ? undefined : [user.id],
  };
}

async function resolvePipelineArg(pipelineId: string | undefined): Promise<string> {
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
  const scoped = await scopedDashboardFilters(user, pipelineId);
  if (!scoped) throw new ToolError("forbidden", "Sem acesso a este funil.");
  const data = await getDashboard({ from: range.from, to: range.to, pipelineId, ...scoped });
  return {
    period: { from: iso(range.from), to: iso(range.to) },
    pipelineId: pipelineId || "all",
    onlyOwnDeals: Boolean(scoped.ownerIds),
    summary: data.summary,
    newDeals: data.newDeals,
    bySource: data.bySource.slice(0, 20),
    lossReasons: data.lossReasons.slice(0, 20),
    dailyEvolution: data.dailyEvolution,
  };
}

export async function getTeamPerformance(env: ToolEnv, args: PeriodArgs & { pipelineId?: string }) {
  const { user } = env;
  // Mesmo gate do Painel de equipe: gestor ou administrador.
  if (user.role !== "ADMIN" && user.role !== "MANAGER") {
    throw new ToolError("forbidden", "Desempenho da equipe é restrito a gestores e administradores.");
  }
  const range = resolvePeriod(args);
  const pipelineId = await resolvePipelineArg(args.pipelineId);
  if (pipelineId && (await requirePipelineScope(user, "view", pipelineId))) {
    throw new ToolError("forbidden", "Sem acesso a este funil.");
  }
  const scoped = await scopedDashboardFilters(user, pipelineId);
  if (!scoped) throw new ToolError("forbidden", "Sem acesso a este funil.");
  const data = await getDashboard({ from: range.from, to: range.to, pipelineId, ...scoped });
  return {
    period: { from: iso(range.from), to: iso(range.to) },
    pipelineId: pipelineId || "all",
    onlyOwnDeals: Boolean(scoped.ownerIds),
    sellers: data.byOwner.map((o) => ({
      id: o.id,
      name: o.name,
      leads: o.leads,
      open: o.open,
      won: o.won,
      lost: o.lost,
      conversion: o.conversion,
      wonValue: o.wonValue,
    })),
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
  const scoped = await scopedDashboardFilters(user, pipelineId);
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
  for (const k of ["items", "messages", "sellers", "stages"]) {
    if (Array.isArray(r[k])) return (r[k] as unknown[]).length;
  }
  return 1;
}
