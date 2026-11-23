/**
 * Ferramentas MCP de atendimento (somente leitura):
 *   list_conversations, get_conversation_messages, get_conversation_events,
 *   get_queue_status, get_team_performance.
 *
 * Visibilidade igual à da inbox (`getVisibilityFilter` + filas liberadas +
 * funil + canais permitidos); operador (`env.ownOnly`) só as conversas dele.
 * Tudo roda no `prisma` escopado pela org da conexão.
 *
 * Diferente da lista da inbox, `list_conversations` NÃO colapsa tickets por
 * contato: cada conversa é um registro, com cursor estável (campo de ordem +
 * id), para análise sem perder linhas.
 */
import type { ActorType, Prisma } from "@prisma/client";

import { andConversationWhere, conversationFunnelWhere } from "@/lib/authz/funnel-visibility";
import { canDoChannelAction, listAllowedChannelIds } from "@/lib/authz/resource-policy";
import { resolveConversationId, userHasConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { createRequestMemo } from "@/lib/request-memo";
import {
  getDepartmentScopeForConversations,
  getVisibilityFilter,
  withInboxQueueVisibility,
} from "@/lib/visibility";
import { getMediaTexts } from "@/services/ai-v2/media-understanding";
import { getDashboard } from "@/services/dashboard";
import { parseClockMode, parseDay } from "@/services/painel-period";
import { getPainelService } from "@/services/painel-service";
import { getPainelTeam } from "@/services/painel-team";

import {
  authzOf,
  contactOut,
  iso,
  OWN_ONLY_DENIED,
  ownConversationWhere,
  resolvePeriod,
  resolvePipelineArg,
  scopedDashboardFilters,
  ToolError,
  truncate,
  type PeriodArgs,
  type ToolEnv,
} from "./tools";

// ──────────────────────────────────────────────────────────────────────
// Base: visibilidade, datas, cursor, tabulação e quem encerrou
// ──────────────────────────────────────────────────────────────────────

/** Recorte de conversas que o usuário pode ver (mesma regra da inbox). */
async function visibleConversationWhere(env: ToolEnv): Promise<Prisma.ConversationWhereInput> {
  const { user } = env;
  const memo = createRequestMemo();
  const [allowedChannelIds, authz, visibility] = await Promise.all([
    listAllowedChannelIds(user, memo),
    authzOf(user),
    getVisibilityFilter(user, { memo }),
  ]);
  const inboxPerms: ReadonlySet<string> = authz.isAdmin ? new Set(["*"]) : authz.permissions;
  const base = andConversationWhere(
    env.ownOnly
      ? ownConversationWhere(user.id)
      : withInboxQueueVisibility(visibility.conversationWhere, {
          permissions: inboxPerms,
          includeUnassigned: visibility.includeUnassigned,
        }),
    conversationFunnelWhere(authz),
  ) ?? {};
  return allowedChannelIds ? { AND: [base, { channelId: { in: allowedChannelIds } }] } : base;
}

/**
 * Limite de período: `YYYY-MM-DD` (dia inteiro, fuso de São Paulo — igual
 * ao painel) ou data/hora ISO-8601.
 */
export function parseBound(raw: string | undefined, end: boolean, name: string): Date | undefined {
  if (!raw) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDay(raw, end) : new Date(raw);
  if (!d || Number.isNaN(d.getTime())) {
    throw new ToolError("invalid_argument", `${name} inválido (use YYYY-MM-DD ou ISO-8601).`);
  }
  return d;
}

function rangeFilter(
  from: string | undefined,
  to: string | undefined,
  label: string,
): Prisma.DateTimeNullableFilter | undefined {
  const gte = parseBound(from, false, `${label}From`);
  const lte = parseBound(to, true, `${label}To`);
  if (!gte && !lte) return undefined;
  if (gte && lte && gte > lte) {
    throw new ToolError("invalid_argument", `${label}From depois de ${label}To.`);
  }
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

type SortField = "createdAt" | "updatedAt" | "closedAt";
type Cursor = { s: SortField; o: "asc" | "desc"; v: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(raw: string, sort: SortField, order: "asc" | "desc"): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (c.s !== sort || c.o !== order || typeof c.id !== "string" || Number.isNaN(new Date(c.v).getTime())) {
      throw new Error("cursor");
    }
    return c;
  } catch {
    throw new ToolError("invalid_argument", "cursor inválido (use o nextCursor da mesma consulta).");
  }
}

/** Keyset: depois de (v, id) na ordem pedida — sem pular nem repetir linha. */
function afterCursor(c: Cursor): Prisma.ConversationWhereInput {
  const v = new Date(c.v);
  const cmp = c.o === "desc" ? "lt" : "gt";
  return {
    OR: [{ [c.s]: { [cmp]: v } }, { [c.s]: v, id: { [cmp]: c.id } }],
  } as Prisma.ConversationWhereInput;
}

/** Caminho da tabulação ("Pai › Filho"), subindo `parentId`. */
export async function tabulationPaths(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter(Boolean))];
  if (want.length === 0) return out;
  const nodes = new Map<string, { name: string; parentId: string | null }>();
  let pending = want;
  for (let depth = 0; depth < 8 && pending.length > 0; depth++) {
    const rows = await prisma.tabulation.findMany({
      where: { id: { in: pending } },
      select: { id: true, name: true, parentId: true },
    });
    for (const r of rows) nodes.set(r.id, { name: r.name, parentId: r.parentId });
    pending = rows.map((r) => r.parentId).filter((p): p is string => Boolean(p) && !nodes.has(p as string));
  }
  for (const id of want) {
    const names: string[] = [];
    let cur: string | null = id;
    for (let i = 0; cur && i < 8; i++) {
      const n = nodes.get(cur);
      if (!n) break;
      names.unshift(n.name);
      cur = n.parentId;
    }
    if (names.length) out.set(id, names.join(" › "));
  }
  return out;
}

export type CloserType = "pessoa" | "ia" | "automacao" | "massa" | "inatividade" | "sistema" | "integracao";

/**
 * Quem encerrou, a partir do `CONVERSATION_CLOSED`. IA e fechamento em massa
 * passam pelo mesmo `resolveConversationsInline` (`meta.source="bulk-sync"`);
 * só o `actorType` separa os dois.
 */
export function classifyCloser(ev: { actorType: ActorType | string; meta: unknown }): CloserType {
  const meta = (ev.meta && typeof ev.meta === "object" ? ev.meta : {}) as Record<string, unknown>;
  const source = typeof meta.source === "string" ? meta.source : null;
  if (ev.actorType === "AI" || meta.action === "ai_tabulate_close") return "ia";
  if (ev.actorType === "AUTOMATION" || source === "automation") return "automacao";
  if (source === "idle_inbound") return "inatividade";
  if (ev.actorType === "HUMAN" && source === "bulk-sync") return "massa";
  if (ev.actorType === "INTEGRATION") return "integracao";
  if (ev.actorType === "SYSTEM") return "sistema";
  return "pessoa";
}

const CLOSE_SELECT = {
  conversationId: true,
  occurredAt: true,
  actorType: true,
  actorLabel: true,
  meta: true,
  actorUser: { select: { name: true } },
} as const;

/** Último encerramento de cada conversa (quem e quando). */
async function lastClosers(conversationIds: string[]) {
  const out = new Map<string, { type: CloserType; name: string | null; at: string | null }>();
  if (conversationIds.length === 0) return out;
  const rows = await prisma.activityEvent.findMany({
    where: { conversationId: { in: conversationIds }, type: "CONVERSATION_CLOSED" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: CLOSE_SELECT,
    take: Math.min(2000, conversationIds.length * 10),
  });
  for (const r of rows) {
    if (!r.conversationId || out.has(r.conversationId)) continue;
    const type = classifyCloser(r);
    out.set(r.conversationId, {
      type,
      name: type === "pessoa" || type === "massa" ? (r.actorUser?.name ?? r.actorLabel ?? null) : (r.actorLabel ?? null),
      at: iso(r.occurredAt),
    });
  }
  return out;
}

const CONV_SELECT = {
  id: true,
  number: true,
  status: true,
  channel: true,
  channelId: true,
  contactId: true,
  assignedToId: true,
  departmentId: true,
  tabulationId: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  lastMessageAt: true,
  lastInboundAt: true,
  lastMessageDirection: true,
  unreadCount: true,
  channelRef: { select: { name: true } },
  department: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true, type: true } },
  contact: { select: { id: true, name: true, email: true, phone: true } },
} as const;

type ConvRow = Prisma.ConversationGetPayload<{ select: typeof CONV_SELECT }>;

async function conversationsOut(env: ToolEnv, rows: ConvRow[]) {
  const [paths, closers] = await Promise.all([
    tabulationPaths(rows.map((r) => r.tabulationId).filter((v): v is string => Boolean(v))),
    lastClosers(rows.filter((r) => r.status === "RESOLVED" || r.closedAt).map((r) => r.id)),
  ]);
  return rows.map((c) => ({
    id: c.id,
    number: c.number,
    status: c.status,
    channel: c.channel,
    channelName: c.channelRef?.name ?? null,
    department: c.department ? { id: c.department.id, name: c.department.name } : null,
    assignedTo: c.assignedTo
      ? { id: c.assignedTo.id, name: c.assignedTo.name, type: c.assignedTo.type === "AI" ? "ia" : "humano" }
      : null,
    contact: contactOut(env, c.contact),
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
    closedAt: iso(c.closedAt),
    lastMessageAt: iso(c.lastMessageAt),
    lastInboundAt: iso(c.lastInboundAt),
    lastMessageDirection: c.lastMessageDirection ?? null,
    unreadCount: c.unreadCount,
    tabulation: c.tabulationId
      ? { id: c.tabulationId, path: paths.get(c.tabulationId) ?? null }
      : null,
    closedBy: closers.get(c.id) ?? null,
  }));
}

/** Carrega a conversa e confere acesso (mesma regra do inbox + operador). */
async function loadAccessibleConversation(env: ToolEnv, idOrNumber: string): Promise<ConvRow> {
  const { user } = env;
  const conversationId = await resolveConversationId(idOrNumber);
  if (!conversationId) throw new ToolError("not_found", "Conversa não encontrada.");
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId }, select: CONV_SELECT });
  if (!conv) throw new ToolError("not_found", "Conversa não encontrada.");
  const allowed =
    (await userHasConversationAccess(user, conv.id)) &&
    (await canDoChannelAction(user, "view", conv.channelId));
  if (!allowed) throw new ToolError("forbidden", "Sem acesso a esta conversa.");
  if (env.ownOnly && conv.assignedToId !== user.id) {
    const ownsDeal = await prisma.deal.findFirst({
      where: { contactId: conv.contactId, ownerId: user.id },
      select: { id: true },
    });
    if (!ownsDeal) throw new ToolError("forbidden", "Esta conversa não está sob sua responsabilidade.");
  }
  return conv;
}

// ──────────────────────────────────────────────────────────────────────
// list_conversations
// ──────────────────────────────────────────────────────────────────────

export type ListConversationsArgs = {
  status?: "OPEN" | "RESOLVED" | "PENDING" | "SNOOZED";
  channel?: string;
  channelId?: string;
  /** Departamento/fila; `none` = sem departamento. */
  departmentId?: string;
  /** Atendente: id, `me` ou `none` (sem responsável). `ownerId` = alias antigo. */
  assignedToId?: string;
  ownerId?: string;
  tabulationId?: string;
  contactId?: string;
  search?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  closedFrom?: string;
  closedTo?: string;
  sort?: SortField;
  order?: "asc" | "desc";
  cursor?: string;
  perPage?: number;
};

export async function listConversations(env: ToolEnv, args: ListConversationsArgs) {
  const { user } = env;
  const sort: SortField = args.sort ?? "createdAt";
  const order = args.order ?? "desc";
  const perPage = Math.min(50, Math.max(1, args.perPage ?? 20));
  const filters: Prisma.ConversationWhereInput[] = [await visibleConversationWhere(env)];

  if (args.status) filters.push({ status: args.status });
  if (args.channel) filters.push({ channel: args.channel });
  if (args.channelId) filters.push({ channelId: args.channelId });
  if (args.departmentId) {
    filters.push({ departmentId: args.departmentId === "none" ? null : args.departmentId });
  }
  const assignee = args.assignedToId ?? args.ownerId;
  if (assignee) {
    filters.push({ assignedToId: assignee === "none" ? null : assignee === "me" ? user.id : assignee });
  }
  if (args.tabulationId) filters.push({ tabulationId: args.tabulationId });
  if (args.contactId) filters.push({ contactId: args.contactId });
  const created = rangeFilter(args.createdFrom, args.createdTo, "created");
  const updated = rangeFilter(args.updatedFrom, args.updatedTo, "updated");
  const closed = rangeFilter(args.closedFrom, args.closedTo, "closed");
  if (created) filters.push({ createdAt: created as Prisma.DateTimeFilter });
  if (updated) filters.push({ updatedAt: updated as Prisma.DateTimeFilter });
  if (closed) filters.push({ closedAt: closed });
  // Ordenar por encerramento só faz sentido entre as encerradas.
  if (sort === "closedAt") filters.push({ closedAt: { not: null } });
  const search = args.search?.trim().slice(0, 100);
  if (search) {
    const digits = search.replace(/\D/g, "");
    filters.push({
      contact: {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
        ],
      },
    });
  }
  if (args.cursor) filters.push(afterCursor(decodeCursor(args.cursor, sort, order)));

  const rows = await prisma.conversation.findMany({
    where: { AND: filters },
    orderBy: [{ [sort]: order }, { id: order }] as Prisma.ConversationOrderByWithRelationInput[],
    take: perPage + 1,
    select: CONV_SELECT,
  });
  const hasMore = rows.length > perPage;
  const page = rows.slice(0, perPage);
  const last = page[page.length - 1];
  const lastValue = last ? (last[sort] as Date | null) : null;
  return {
    scope: env.ownOnly ? "own" : "visible",
    sort,
    order,
    hasMore,
    nextCursor:
      hasMore && last && lastValue
        ? encodeCursor({ s: sort, o: order, v: lastValue.toISOString(), id: last.id })
        : null,
    items: await conversationsOut(env, page),
  };
}

// ──────────────────────────────────────────────────────────────────────
// get_conversation_messages
// ──────────────────────────────────────────────────────────────────────

const AUDIO_TYPES = new Set(["audio", "ptt", "voice", "voice_note"]);

export type SenderType = "contato" | "atendente" | "agente_ia" | "automacao" | "sistema";

/** Quem enviou: contato, atendente, agente de IA, automação (inclui campanha) ou sistema. */
export function classifySender(m: {
  direction: string;
  authorType: string;
  aiAgentUserId: string | null;
}): SenderType {
  if (m.direction === "in") return "contato";
  if (m.authorType === "system") return "sistema";
  if (m.authorType === "bot") return m.aiAgentUserId ? "agente_ia" : "automacao";
  return "atendente";
}

export async function getConversationMessages(
  env: ToolEnv,
  args: { conversationId: string; before?: string; limit?: number },
) {
  const conv = await loadAccessibleConversation(env, args.conversationId);
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
      aiAgentUserId: true,
      senderName: true,
      sendStatus: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  // Transcrição só com o escopo `audio:read` (só existe para áudio que a IA processou).
  const audioIds = page.filter((m) => AUDIO_TYPES.has(m.messageType)).map((m) => m.id);
  const transcripts =
    env.scopes.includes("audio:read") && audioIds.length > 0
      ? await getMediaTexts(env.user.organizationId, audioIds)
      : new Map<string, string>();
  const [header] = await conversationsOut(env, [conv]);
  return {
    conversation: header,
    hasMore,
    nextBefore: hasMore ? iso(page[page.length - 1]?.createdAt) : null,
    // Ordem cronológica (mais antiga primeiro) — leitura natural para o modelo.
    messages: page.reverse().map((m) => {
      const sender = classifySender(m);
      const isAudio = AUDIO_TYPES.has(m.messageType);
      const transcript = isAudio ? transcripts.get(m.id) : undefined;
      return {
        id: m.id,
        at: iso(m.createdAt),
        direction: m.direction,
        senderType: sender,
        senderName: sender === "contato" ? null : (m.senderName ?? null),
        type: m.messageType,
        text: isAudio
          ? (transcript ? truncate(transcript, 4000) : "[áudio]")
          : m.messageType === "text" || m.content.length < 4000
            ? truncate(m.content, 4000)
            : `[${m.messageType}]`,
        ...(isAudio ? { transcribed: Boolean(transcript) } : {}),
        status: m.sendStatus,
      };
    }),
  };
}

// ──────────────────────────────────────────────────────────────────────
// get_conversation_events (escopo events:read)
// ──────────────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  "ASSIGNEE_CHANGED",
  "LEAD_DISTRIBUTED",
  "LEAD_DISTRIBUTION_FAILED",
  "CONVERSATION_DEPARTMENT_CHANGED",
  "CONVERSATION_CREATED",
  "CONVERSATION_REOPENED",
  "CONVERSATION_STATUS_CHANGED",
  "CONVERSATION_FOLLOWUP_SET",
  "CONVERSATION_CLOSED",
  "CONVERSATION_TABULATED",
];

export const EVENT_CATEGORIES = [
  "abertura",
  "reabertura",
  "status",
  "retorno_agendado",
  "atribuicao",
  "retomada_ia",
  "devolucao_humano",
  "distribuicao",
  "distribuicao_falhou",
  "transferencia_departamento",
  "entrada_fila",
  "saida_fila",
  "encerramento",
  "tabulacao",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

type TimelineEvent = {
  id: string;
  at: string;
  category: EventCategory;
  actor: { type: string; name: string | null } | null;
  [k: string]: unknown;
};

function metaOf(m: unknown): Record<string, unknown> {
  return m && typeof m === "object" ? (m as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
const ACTOR_LABEL: Record<string, string> = {
  HUMAN: "pessoa",
  AI: "ia",
  AUTOMATION: "automacao",
  INTEGRATION: "integracao",
  SYSTEM: "sistema",
};

export async function getConversationEvents(
  env: ToolEnv,
  args: { conversationId: string; categories?: string[]; cursor?: string; limit?: number },
) {
  const conv = await loadAccessibleConversation(env, args.conversationId);
  const limit = Math.min(100, Math.max(1, args.limit ?? 50));
  const [activity, pending] = await Promise.all([
    prisma.activityEvent.findMany({
      where: { conversationId: conv.id, type: { in: EVENT_TYPES } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 1000,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        actorType: true,
        actorLabel: true,
        actorUser: { select: { name: true } },
        oldValue: true,
        newValue: true,
        tabulationId: true,
        meta: true,
      },
    }),
    prisma.distributionPending.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true, status: true, createdAt: true, resolvedAt: true, resolvedUserId: true },
    }),
  ]);

  // Tipo (IA/humano) dos usuários citados nas trocas de responsável.
  const userIds = new Set<string>();
  for (const e of activity) {
    const m = metaOf(e.meta);
    for (const k of ["fromUserId", "toUserId", "selectedUserId"]) if (str(m[k])) userIds.add(m[k] as string);
  }
  for (const p of pending) if (p.resolvedUserId) userIds.add(p.resolvedUserId);
  const users = userIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...userIds] }, organizationId: env.user.organizationId },
        select: { id: true, name: true, type: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const tabPaths = await tabulationPaths(
    activity.map((e) => e.tabulationId ?? str(metaOf(e.meta).tabulationId)).filter((v): v is string => Boolean(v)),
  );

  const events: TimelineEvent[] = [];
  for (const e of activity) {
    const m = metaOf(e.meta);
    const actor = {
      type: ACTOR_LABEL[String(e.actorType)] ?? String(e.actorType).toLowerCase(),
      name: e.actorUser?.name ?? e.actorLabel ?? null,
    };
    const base = { id: e.id, at: e.occurredAt.toISOString(), actor };
    switch (e.type) {
      case "ASSIGNEE_CHANGED": {
        const from = str(m.fromUserId) ? userById.get(m.fromUserId as string) : undefined;
        const to = str(m.toUserId) ? userById.get(m.toUserId as string) : undefined;
        const category: EventCategory =
          to?.type === "AI" ? "retomada_ia" : from?.type === "AI" && to ? "devolucao_humano" : "atribuicao";
        events.push({
          ...base,
          category,
          from: e.oldValue ?? from?.name ?? null,
          to: e.newValue ?? to?.name ?? null,
          reason: str(m.reason),
        });
        break;
      }
      case "LEAD_DISTRIBUTED":
      case "LEAD_DISTRIBUTION_FAILED": {
        const sel = str(m.selectedUserId) ? userById.get(m.selectedUserId as string) : undefined;
        events.push({
          ...base,
          category: e.type === "LEAD_DISTRIBUTED" ? "distribuicao" : "distribuicao_falhou",
          to: sel?.name ?? e.newValue ?? null,
          department: str(m.departmentName),
          reason: str(m.reason),
        });
        break;
      }
      case "CONVERSATION_DEPARTMENT_CHANGED":
        events.push({
          ...base,
          category: "transferencia_departamento",
          from: str(m.fromDepartmentName) ?? e.oldValue ?? null,
          to: str(m.toDepartmentName) ?? e.newValue ?? null,
        });
        break;
      case "CONVERSATION_CLOSED": {
        const type = classifyCloser(e);
        const tabId = e.tabulationId ?? str(m.tabulationId);
        events.push({
          ...base,
          category: "encerramento",
          closedBy: { type, name: actor.name },
          tabulation: tabId ? { id: tabId, path: tabPaths.get(tabId) ?? str(m.tabulationName) } : null,
        });
        break;
      }
      case "CONVERSATION_TABULATED": {
        const tabId = e.tabulationId ?? str(m.tabulationId);
        events.push({
          ...base,
          category: "tabulacao",
          tabulation: tabId ? { id: tabId, path: tabPaths.get(tabId) ?? str(m.tabulationName) } : null,
        });
        break;
      }
      case "CONVERSATION_CREATED":
        events.push({ ...base, category: "abertura" });
        break;
      case "CONVERSATION_REOPENED":
        events.push({ ...base, category: "reabertura" });
        break;
      case "CONVERSATION_FOLLOWUP_SET":
        events.push({ ...base, category: "retorno_agendado", to: e.newValue ?? null });
        break;
      default:
        events.push({ ...base, category: "status", from: e.oldValue ?? null, to: e.newValue ?? null });
    }
  }
  // Fila de espera da distribuição (`distribution_pending`).
  for (const p of pending) {
    events.push({ id: `${p.id}:in`, at: p.createdAt.toISOString(), category: "entrada_fila", actor: { type: "sistema", name: null } });
    if (p.resolvedAt) {
      events.push({
        id: `${p.id}:out`,
        at: p.resolvedAt.toISOString(),
        category: "saida_fila",
        actor: { type: "sistema", name: null },
        outcome: p.status === "RESOLVED" ? "atribuida" : "cancelada",
        to: p.resolvedUserId ? (userById.get(p.resolvedUserId)?.name ?? null) : null,
      });
    }
  }
  events.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));

  const wanted = (args.categories ?? []).filter((c): c is EventCategory =>
    (EVENT_CATEGORIES as readonly string[]).includes(c),
  );
  let list = wanted.length ? events.filter((e) => wanted.includes(e.category)) : events;
  if (args.cursor) {
    let c: { at: string; id: string };
    try {
      c = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")) as { at: string; id: string };
      if (typeof c.at !== "string" || typeof c.id !== "string") throw new Error("cursor");
    } catch {
      throw new ToolError("invalid_argument", "cursor inválido (use o nextCursor da mesma consulta).");
    }
    list = list.filter((e) => e.at > c.at || (e.at === c.at && e.id.localeCompare(c.id) > 0));
  }
  const page = list.slice(0, limit);
  const hasMore = list.length > limit;
  const last = page[page.length - 1];
  return {
    conversation: { id: conv.id, number: conv.number, status: conv.status },
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url") : null,
    events: page,
  };
}

// ──────────────────────────────────────────────────────────────────────
// get_queue_status (escopo queue:read) — agregado, sem dado pessoal
// ──────────────────────────────────────────────────────────────────────

/** Esperando resposta agora: mesma regra do "Agora" do painel. */
const WAITING_WHERE: Prisma.ConversationWhereInput = {
  status: "OPEN",
  closedAt: null,
  followUpAt: null,
  lastMessageDirection: "in",
  hasError: false,
};

export async function getQueueStatus(env: ToolEnv) {
  if (env.ownOnly) throw new ToolError("forbidden", OWN_ONLY_DENIED);
  const { user } = env;
  const visible = await visibleConversationWhere(env);
  const where: Prisma.ConversationWhereInput = { AND: [visible, WAITING_WHERE] };
  const [waiting, unassigned, deptScope, departments, online] = await Promise.all([
    prisma.conversation.groupBy({
      by: ["departmentId"],
      where,
      _count: { _all: true },
      _min: { lastInboundAt: true },
    }),
    prisma.conversation.groupBy({
      by: ["departmentId"],
      where: { AND: [where, { assignedToId: null }] },
      _count: { _all: true },
    }),
    getDepartmentScopeForConversations(user),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.agentStatus.findMany({
      where: { status: "ONLINE", user: { type: "HUMAN", organizationId: user.organizationId } },
      select: { userId: true },
    }),
  ]);
  const onlineIds = online.map((o) => o.userId);
  const members = onlineIds.length
    ? await prisma.departmentMember.findMany({
        where: { userId: { in: onlineIds } },
        select: { departmentId: true },
      })
    : [];
  const onlineByDept = new Map<string, number>();
  for (const m of members) onlineByDept.set(m.departmentId, (onlineByDept.get(m.departmentId) ?? 0) + 1);
  const unassignedByDept = new Map(unassigned.map((u) => [u.departmentId ?? "", u._count._all]));
  const waitingByDept = new Map(waiting.map((w) => [w.departmentId ?? "", w]));
  const now = Date.now();
  const minutes = (d: Date | null | undefined) => (d ? Math.max(0, Math.round((now - d.getTime()) / 60000)) : null);

  const scoped = deptScope ? new Set(deptScope) : null;
  const rows = departments
    .filter((d) => !scoped || scoped.has(d.id))
    .map((d) => {
      const w = waitingByDept.get(d.id);
      return {
        departmentId: d.id,
        department: d.name,
        waiting: w?._count._all ?? 0,
        waitingUnassigned: unassignedByDept.get(d.id) ?? 0,
        oldestWaitMinutes: minutes(w?._min.lastInboundAt),
        onlineAttendants: onlineByDept.get(d.id) ?? 0,
      };
    });
  const none = waitingByDept.get("");
  if (!scoped && none) {
    rows.push({
      departmentId: "none",
      department: "Sem departamento",
      waiting: none._count._all,
      waitingUnassigned: unassignedByDept.get("") ?? 0,
      oldestWaitMinutes: minutes(none._min.lastInboundAt),
      onlineAttendants: 0,
    });
  }
  return {
    asOf: new Date(now).toISOString(),
    totals: {
      waiting: rows.reduce((a, r) => a + r.waiting, 0),
      waitingUnassigned: rows.reduce((a, r) => a + r.waitingUnassigned, 0),
      onlineAttendants: scoped ? rows.reduce((a, r) => a + r.onlineAttendants, 0) : onlineIds.length,
    },
    departments: rows,
  };
}

// ──────────────────────────────────────────────────────────────────────
// get_team_performance (gestor/admin)
// ──────────────────────────────────────────────────────────────────────

const minutesOf = (ms: number | null | undefined) =>
  typeof ms === "number" && Number.isFinite(ms) ? Math.round((ms / 60000) * 10) / 10 : null;

export async function getTeamPerformance(
  env: ToolEnv,
  args: PeriodArgs & { pipelineId?: string; departmentIds?: string[]; clock?: "business" | "elapsed" },
) {
  const { user } = env;
  if (env.ownOnly || (user.role !== "ADMIN" && user.role !== "MANAGER")) {
    throw new ToolError("forbidden", OWN_ONLY_DENIED);
  }
  const range = resolvePeriod(args);
  const clock = parseClockMode(args.clock ?? null);
  const departmentIds = (args.departmentIds ?? []).map((d) => (d === "none" ? "__none__" : d)).slice(0, 50);

  // Vendas por vendedor (negócios) — como antes.
  const pipelineId = await resolvePipelineArg(args.pipelineId);
  const scoped = await scopedDashboardFilters(user, pipelineId, env.ownOnly);
  if (!scoped) throw new ToolError("forbidden", "Sem acesso a este funil.");
  const [dashboard, team, service] = await Promise.all([
    getDashboard({ from: range.from, to: range.to, pipelineId, ...scoped }),
    getPainelTeam(range, clock, { departmentIds, userIds: [] }, ["ranking", "transfers"]),
    getPainelService(range, clock, ["attendants"]),
  ]);

  // Atendimento por atendente (painel de equipe + 1ª resposta do painel de atendimento).
  const firstResponse = new Map<string, number | null>();
  if (service.attendants.ok) {
    for (const r of service.attendants.data.rows) firstResponse.set(r.id, r.firstResponseMedianMs);
  }
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  if (team.transfers.ok) {
    for (const f of team.transfers.data.people.flows) {
      out.set(f.from.id, (out.get(f.from.id) ?? 0) + f.count);
      inn.set(f.to.id, (inn.get(f.to.id) ?? 0) + f.count);
    }
  }
  const attendants = team.ranking.ok
    ? team.ranking.data.rows.map((r) => ({
        id: r.id,
        name: r.name,
        attended: r.attended,
        finished: r.finished,
        firstResponseMedianMinutes: minutesOf(firstResponse.get(r.id) ?? null),
        serviceMeanMinutes: minutesOf(r.serviceMeanMs),
        serviceMedianMinutes: minutesOf(r.serviceMedianMs),
        transferredOut: out.get(r.id) ?? 0,
        transferredIn: inn.get(r.id) ?? 0,
      }))
    : [];
  return {
    period: { from: iso(range.from), to: iso(range.to) },
    effectiveFrom: team.effectiveFrom,
    rangeClamped: team.rangeClamped,
    clock,
    departmentIds: args.departmentIds ?? [],
    notes: [
      "Tempos em minutos; clock=business conta só o horário de atendimento.",
      "firstResponseMedianMinutes considera todas as conversas do atendente no período (o filtro de departamento não se aplica a ele).",
    ],
    attendants,
    ...(team.ranking.ok ? {} : { attendantsError: "Indicadores de atendimento indisponíveis no momento." }),
    sellers: dashboard.byOwner.map((o) => ({
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
