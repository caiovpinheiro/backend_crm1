/**
 * Fila de espera da Distribuição.
 *
 * A fila reflete os ATENDIMENTOS da aba "Entrada" que ainda estão SEM
 * responsável (conversa aberta, sem `assignedToId`). Deriva do mesmo
 * critério da aba Entrada do inbox. A drenagem automática passa por
 * `processPendingDistributionQueue` (gatilhos: novo item, agente online,
 * elegibilidade, capacidade liberada, botão manual; cron só se a última
 * passagem não foi vazia).
 * Na API o scan não roda in-process: `enqueueProcessPendingOrRun`
 * só empurra `distribution-drain` (sem COUNT / queueLimit). O worker
 * confere o teto em `capacity_released` e drena. Fallback síncrono
 * só em test/dev se Redis estiver down.
 * A drenagem é **por departamento** (FIFO + capacidade). Quem fica
 * elegível abre a fila dos seus depts; o reprocesso manual/cron também
 * tenta os depts que já têm gente na espera — o motor decide se o
 * pool é o depto ou org-wide (`respectDepartment`).
 *
 * Import unidirecional: pending → engine (evita ciclo de import).
 * O engine agenda drenagem via import dinâmico.
 */

import { Prisma } from "@prisma/client";

import {
  allowInlineDistributionFallback,
  enqueueDistributionDrain,
  isFreshDrainEnqueue,
} from "@/lib/distribution-drain-queue";
import { metrics } from "@/lib/metrics";
import { debugInfo, debugWarn } from "@/lib/debug-log";
import { getOrgSettingBool } from "@/lib/org-settings";
import { activeInboxQueueGuardWhere } from "@/lib/inbox-queue-membership";
import { prisma } from "@/lib/prisma";
import {
  getOrgIdOrNull,
  runWithContext,
} from "@/lib/request-context";
import { hasOrganizationWidget } from "@/services/organization-widgets";

import { isAiAttendanceEnabled } from "@/services/ai/attendance-gate";
import { tryAssignFirstAttendanceAi } from "@/services/ai/first-attendance";
import { isHumanAttendanceWindowOpen } from "@/services/ai/human-queue-policy";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import {
  clearOwnershipForRedistribution,
  isAssigneeCurrentlyEligible,
  shouldClearOwnershipOnIneligible,
  shouldKeepAssigneeInAttendance,
} from "@/services/distribution/assignee-eligibility";
import { humanWasAssignedInThisConversation } from "@/services/distribution/human-assignment-history";
import { keepHumanAfterAutomationClose } from "@/services/distribution/return-after-close";

import { executeDistribution } from "./engine";
import { isDistributionEnabled } from "./enabled";
import { evaluateCapacityReleasedDrain } from "./capacity-released-gate";
import {
  CAPACITY_RELEASED_COOLDOWN_MS,
  fruitlessCooldownIsArmed,
  fruitlessPassNeedsCooldown,
  shouldScheduleRetryOnCooldownSkip,
  shouldSkipCapacityReleasedCooldown,
  shouldSkipCapacityReleasedFruitlessCooldown,
  shouldSkipScheduledFruitlessCooldown,
  triggerClearsFruitlessCooldown,
} from "./pending-drain-guard";
import {
  clearPublishedFruitlessCooldown,
  peekPublishedFruitlessCooldown,
  publishFruitlessCooldown,
} from "./pending-drain-store";
import {
  getDistributionResponsibles,
  type DistributionResponsibleView,
} from "./responsibles";

export interface PendingDistributionView {
  id: string;
  /** Ticket sequencial da org — usado em `/inbox?c=<number>`. */
  number: number | null;
  dealId: string | null;
  contactId: string | null;
  /** Nome amigável: título do negócio, nome do contato, ou fallback. */
  label: string;
  /** Canal de origem da conversa (WHATSAPP, INSTAGRAM, FACEBOOK, EMAIL, WEBCHAT). */
  channel: string;
  departmentId: string | null;
  departmentName: string | null;
  distributionType: string | null;
  triggerSource: string;
  attempts: number;
  lastAttemptAt: string;
  createdAt: string;
}

/**
 * Critério da fila = atendimentos ABERTOS SEM responsável (`assignedToId=null`)
 * em que o contato JÁ RESPONDEU pelo menos uma vez (`lastInboundAt` preenchido).
 *
 * Calouros que só receberam template "BV / Bem-vindo" e nunca responderam
 * NÃO entram na fila de espera nem na drenagem — só passam a contar quando
 * houver inbound real do aluno.
 *
 * NÃO usamos `hasAgentReply` de propósito: uma resposta de AUTOMAÇÃO/IA marca
 * `hasAgentReply=true` e tiraria o lead da aba "Entrada", mas ele continua SEM
 * responsável humano e PRECISA ser distribuído (desde que já tenha inbound).
 */
export const ABERTA_SEM_RESPONSAVEL: Prisma.ConversationWhereInput = {
  ...activeInboxQueueGuardWhere(),
  assignedToId: null,
  lastInboundAt: { not: null },
  // Modo leads: conversa marcada (routeMode) ou roteada a departamento leads
  // fica FORA da fila de espera smart — a distribuição é do bloco mode="leads".
  // `OR` explícito: `routeMode: { not: "leads" }` sozinho excluiria NULL
  // (semântica de 3 valores do SQL).
  OR: [{ routeMode: null }, { routeMode: { not: "leads" } }],
  NOT: { department: { distributionMode: "leads" } },
};

/** Default true: inbound sem dono entra na fila (legado acadêmico). */
const AUTO_ON_INBOUND_KEY = "distribution.autoOnInbound";

export async function isDistributionAutoOnInbound(): Promise<boolean> {
  return getOrgSettingBool(AUTO_ON_INBOUND_KEY, true);
}

/**
 * Filtro da fila de espera: toda conversa OPEN sem responsável (com inbound).
 * `autoOnInbound=false` só deixava de CRIAR pending sozinho — se a drenagem
 * também ignorar esses cards, o aluno fica em Entrada até o dia seguinte.
 */
export async function getWaitingQueueWhere(): Promise<Prisma.ConversationWhereInput> {
  return ABERTA_SEM_RESPONSAVEL;
}

/** Garante linha na fila de espera sem redistribuir (não tira a IA). */
export async function ensureConversationInWaitingQueue(args: {
  conversationId: string;
  contactId: string | null;
  triggerSource: string;
}): Promise<void> {
  if (!args.contactId) return;
  const orgId = getOrgIdOrNull();
  if (!orgId) return;
  // Alvo do modo leads nunca entra na fila de espera smart.
  const convRoute = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      routeMode: true,
      department: { select: { distributionMode: true } },
    },
  });
  if (
    convRoute?.routeMode === "leads" ||
    convRoute?.department?.distributionMode === "leads"
  ) {
    return;
  }
  const existing = await prisma.distributionPending.findFirst({
    where: {
      status: "PENDING",
      OR: [
        { conversationId: args.conversationId },
        { contactId: args.contactId },
      ],
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.distributionPending.update({
      where: { id: existing.id },
      data: {
        conversationId: args.conversationId,
        lastAttemptAt: new Date(),
      },
    });
    return;
  }
  await prisma.distributionPending.create({
    data: {
      organizationId: orgId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      triggerSource: args.triggerSource,
      status: "PENDING",
      attempts: 1,
      lastAttemptAt: new Date(),
    },
  });
}

const PENDING_LIST_DEFAULT = 50;
const PENDING_LIST_MAX = 100;

function parsePendingCursor(
  raw: string | null,
): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [tsStr, id] = raw.split("_");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !id) return null;
  return { createdAt: new Date(ts), id };
}

export interface PendingDistributionsPage {
  pending: PendingDistributionView[];
  nextCursor: string | null;
  total: number;
}

export async function getPendingDistributions(opts: {
  limit?: number;
  cursor?: string | null;
} = {}): Promise<PendingDistributionsPage> {
  const limit = Math.min(
    PENDING_LIST_MAX,
    Math.max(1, opts.limit ?? PENDING_LIST_DEFAULT),
  );
  const cursor = parsePendingCursor(opts.cursor ?? null);

  const { purgeUnansweredFromPendingQueue } = await import("./pending-inbound");
  await purgeUnansweredFromPendingQueue().catch(() => 0);

  const manualPending = await prisma.distributionPending.findMany({
    where: {
      status: "PENDING",
      triggerSource: "MANUAL",
      conversationId: { not: null },
    },
    select: { conversationId: true },
    take: 500,
  });
  const manualConvIds = manualPending
    .map((p) => p.conversationId)
    .filter((id): id is string => Boolean(id));

  const baseWhere: Prisma.ConversationWhereInput = {
    OR: [
      ABERTA_SEM_RESPONSAVEL,
      ...(manualConvIds.length > 0
        ? [
            {
              id: { in: manualConvIds },
              ...activeInboxQueueGuardWhere(),
              assignedToId: null,
              // Modo leads também fica fora da fila smart no ramo MANUAL.
              OR: [{ routeMode: null }, { routeMode: { not: "leads" } }],
              NOT: { department: { distributionMode: "leads" } },
            },
          ]
        : []),
    ],
  };

  const where: Prisma.ConversationWhereInput = cursor
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { createdAt: { gt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { gt: cursor.id } },
            ],
          },
        ],
      }
    : baseWhere;

  const [itemsPlus, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        number: true,
        channel: true,
        contactId: true,
        departmentId: true,
        createdAt: true,
        updatedAt: true,
        contact: { select: { name: true, phone: true } },
        department: { select: { id: true, name: true } },
      },
    }),
    prisma.conversation.count({ where: baseWhere }),
  ]);

  const hasMore = itemsPlus.length > limit;
  const items = hasMore ? itemsPlus.slice(0, limit) : itemsPlus;

  if (items.length === 0) {
    return { pending: [], nextCursor: null, total };
  }

  const convIds = items.map((c) => c.id);
  const contactIds = items
    .map((c) => c.contactId)
    .filter((id): id is string => Boolean(id));

  const pendRows = await prisma.distributionPending.findMany({
    where: {
      status: "PENDING",
      OR: [
        { conversationId: { in: convIds } },
        ...(contactIds.length > 0 ? [{ contactId: { in: contactIds } }] : []),
      ],
    },
    select: {
      conversationId: true,
      contactId: true,
      triggerSource: true,
      attempts: true,
      lastAttemptAt: true,
      distributionType: true,
      dealId: true,
      createdAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const byConv = new Map<string, (typeof pendRows)[number]>();
  const byContact = new Map<string, (typeof pendRows)[number]>();
  for (const row of pendRows) {
    if (row.conversationId && !byConv.has(row.conversationId)) {
      byConv.set(row.conversationId, row);
    }
    if (row.contactId && !byContact.has(row.contactId)) {
      byContact.set(row.contactId, row);
    }
  }

  const pending = items.map((c) => {
    const meta =
      byConv.get(c.id) ??
      (c.contactId ? byContact.get(c.contactId) : undefined) ??
      null;
    return {
      id: c.id,
      number: c.number ?? null,
      dealId: meta?.dealId ?? null,
      contactId: c.contactId,
      label: c.contact?.phone || c.contact?.name || "Atendimento",
      channel: c.channel ?? "",
      departmentId: c.departmentId ?? c.department?.id ?? null,
      departmentName: c.department?.name ?? null,
      distributionType: meta?.distributionType ?? null,
      triggerSource: meta?.triggerSource ?? "INBOUND",
      attempts: meta?.attempts ?? 0,
      lastAttemptAt: (meta?.lastAttemptAt ?? c.updatedAt).toISOString(),
      createdAt: (meta?.createdAt ?? c.createdAt).toISOString(),
    };
  });

  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;

  return { pending, nextCursor, total };
}

export interface RetryResult {
  resolved: number;
  cancelled: number;
  pending: number;
  trigger?: PendingQueueTrigger;
  skipReason?: string | null;
  skipMessage?: string | null;
}

export type PendingQueueTrigger =
  | "new_item"
  | "agent_online"
  | "agent_eligible"
  | "capacity_released"
  | "manual"
  | "scheduled";

export type DrainState = {
  running: boolean;
  queuedTrigger: PendingQueueTrigger | null;
  queuedUserId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  cooldownUntil: number;
  cooldownReason: string | null;
  cooldownSkipLogged: boolean;
  coalesceLogged: boolean;
};

const drainState = new Map<string, DrainState>();

export function getDrainState(orgId: string) {
  let s = drainState.get(orgId);
  if (!s) {
    s = {
      running: false,
      queuedTrigger: null,
      queuedUserId: null,
      timer: null,
      cooldownUntil: 0,
      cooldownReason: null,
      cooldownSkipLogged: false,
      coalesceLogged: false,
    };
    drainState.set(orgId, s);
  }
  return s;
}

function cancelCapacityReleasedRetry(state: DrainState) {
  if (state.queuedTrigger !== "capacity_released") return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.queuedTrigger = null;
  state.queuedUserId = null;
}

export function armFruitlessCooldown(
  state: DrainState,
  reason: string,
  orgId: string,
) {
  state.cooldownUntil = Date.now() + CAPACITY_RELEASED_COOLDOWN_MS;
  state.cooldownReason = reason;
  state.cooldownSkipLogged = false;
  cancelCapacityReleasedRetry(state);
  void publishFruitlessCooldown(orgId, reason).catch((e) => {
    console.warn("[distribution] publish fruitless cooldown failed", e);
  });
}

export function clearFruitlessCooldown(state: DrainState, orgId?: string) {
  state.cooldownUntil = 0;
  state.cooldownReason = null;
  state.cooldownSkipLogged = false;
  if (!orgId) return;
  void clearPublishedFruitlessCooldown(orgId).catch((e) => {
    console.warn("[distribution] clear fruitless cooldown failed", e);
  });
}

export function isFruitlessCooldownActive(orgId: string): boolean {
  const s = drainState.get(orgId);
  return s != null && fruitlessCooldownIsArmed(s.cooldownReason);
}

export async function isFruitlessCooldownActiveAsync(
  orgId: string,
): Promise<boolean> {
  if (isFruitlessCooldownActive(orgId)) return true;
  return (await peekPublishedFruitlessCooldown(orgId)).armed;
}

export async function bypassFruitlessIfUserHasSlot(
  orgId: string,
  state: DrainState,
  userId?: string | null,
): Promise<boolean> {
  if (!userId) return false;
  try {
    const gate = await evaluateCapacityReleasedDrain({ userId });
    if (!gate.proceed) return false;
    clearFruitlessCooldown(state, orgId);
    debugInfo(
      "[distribution] fruitless bypass — consultant has free slot",
      () => JSON.stringify({
        orgId,
        userId,
        load: gate.load,
        volume: gate.volume,
      }),
    );
    return true;
  } catch (e) {
    console.warn("[distribution] capacity_released slot check failed", e);
    return false;
  }
}

export function logCooldownSkip(
  orgId: string,
  state: DrainState,
  trigger: PendingQueueTrigger,
  via: "schedule" | "process" | "requeue",
) {
  if (state.cooldownSkipLogged) return;
  state.cooldownSkipLogged = true;
  debugInfo(
    "[distribution] processPending skip — cooldown após passagem vazia",
    () => JSON.stringify({
      orgId,
      trigger,
      via,
      reason: state.cooldownReason,
      retryInMs: Math.max(0, state.cooldownUntil - Date.now()),
      scheduled: false,
    }),
  );
}

type ResponsibleCapacity = {
  userId: string;
  queueLimit: number;
  queueCount: number;
  departments: { id: string }[];
};

export function liveFreeCapacityForUser(
  r: Pick<ResponsibleCapacity, "userId" | "queueLimit" | "queueCount">,
  assignedDeltaByUser: Map<string, number>,
): number {
  const delta = assignedDeltaByUser.get(r.userId) ?? 0;
  const loaded = r.queueCount + delta;
  return Math.max(0, r.queueLimit - loaded);
}

export function eligibleInDeptScope(
  eligible: ResponsibleCapacity[],
  deptId: string | null,
): ResponsibleCapacity[] {
  return eligible.filter((r) =>
    deptId === null
      ? true
      : r.departments.some((d) => d.id === deptId),
  );
}

export function takeLimitForDept(
  eligible: ResponsibleCapacity[],
  deptId: string | null,
  assignedDeltaByUser: Map<string, number>,
): number {
  const inScope = eligibleInDeptScope(eligible, deptId);
  if (inScope.length === 0) return 0;
  return inScope.reduce(
    (acc, r) => acc + liveFreeCapacityForUser(r, assignedDeltaByUser),
    0,
  );
}

export function hasRemainingCapacityInScope(
  eligible: ResponsibleCapacity[],
  deptId: string | null,
  assignedDeltaByUser: Map<string, number>,
): boolean {
  return eligibleInDeptScope(eligible, deptId).some(
    (r) => liveFreeCapacityForUser(r, assignedDeltaByUser) > 0,
  );
}

function uniqueDeptNames(names: string[]): string {
  const uniq = Array.from(new Set(names.filter(Boolean)));
  if (uniq.length === 0) return "";
  if (uniq.length === 1) return uniq[0]!;
  if (uniq.length === 2) return `${uniq[0]} e ${uniq[1]}`;
  return `${uniq.slice(0, 2).join(", ")} e mais ${uniq.length - 2}`;
}

export async function explainEmptyDrain(opts: {
  eligible: DistributionResponsibleView[];
  pendingCount: number;
}): Promise<{ skipReason: string; skipMessage: string }> {
  const n = opts.eligible.length;
  if (n === 0) {
    return {
      skipReason: "NO_ELIGIBLE_RESPONSIBLE",
      skipMessage: "Ainda não há responsável elegível para a fila.",
    };
  }
  if (opts.pendingCount <= 0) {
    return {
      skipReason: "EMPTY_QUEUE",
      skipMessage: "Fila de espera vazia.",
    };
  }

  const waiting = await prisma.conversation.findMany({
    where: await getWaitingQueueWhere(),
    select: {
      departmentId: true,
      department: { select: { name: true, distributionEnabled: true } },
    },
    take: 500,
  });

  const byDept = new Map<
    string,
    { name: string; enabled: boolean | null }
  >();
  for (const c of waiting) {
    if (!c.departmentId) continue;
    if (byDept.has(c.departmentId)) continue;
    byDept.set(c.departmentId, {
      name: c.department?.name ?? "Departamento",
      enabled: c.department?.distributionEnabled ?? null,
    });
  }

  const unmatchedNames: string[] = [];
  const disabledNames: string[] = [];
  for (const [deptId, info] of byDept) {
    const inDept = opts.eligible.some((r) =>
      r.departments.some((d) => d.id === deptId),
    );
    if (!inDept) unmatchedNames.push(info.name);
    if (info.enabled === false) disabledNames.push(info.name);
  }

  const respectDepartment = await getOrgSettingBool(
    "distribution.respectDepartment",
    false,
  );

  if (respectDepartment && unmatchedNames.length > 0) {
    const label = uniqueDeptNames(unmatchedNames);
    return {
      skipReason: "NO_ELIGIBLE_IN_DEPARTMENT",
      skipMessage: `Há ${n} elegíveis, mas nenhum no departamento ${label}.`,
    };
  }

  if (respectDepartment && disabledNames.length > 0) {
    const label = uniqueDeptNames(disabledNames);
    return {
      skipReason: "NO_DEPARTMENT",
      skipMessage: `O departamento ${label} não está com distribuição automática habilitada.`,
    };
  }

  const anyCap = opts.eligible.some(
    (r) => liveFreeCapacityForUser(r, new Map()) > 0,
  );
  if (!anyCap) {
    return {
      skipReason: "QUEUE_LIMIT_REACHED",
      skipMessage: `Há ${n} elegíveis, mas todos estão no limite da fila.`,
    };
  }

  return {
    skipReason: "NO_MATCH",
    skipMessage: `Há ${n} elegíveis, mas nenhum pode receber os atendimentos da fila (departamento, capacidade ou horário).`,
  };
}
