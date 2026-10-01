/**
 * Alertas globais de Activity (pré-aviso 15min + vencimento).
 *
 * Destinatários: assignee (userId) e/ou membros atuais do departamento.
 * ADMIN/MANAGER NÃO recebem só por papel — só se forem destinatários.
 * Persistência por (activityId, userId); GET entrega no máx. 1 alerta via
 * claim otimista (updateMany / create+P2002) — exatamente um caller recebe.
 */

import { prisma } from "@/lib/prisma";
import { getUserDepartmentIds } from "@/services/task-visibility";
import { getLogger } from "@/lib/logger";

const log = getLogger("activity-alerts");

export const PRE_DUE_WINDOW_MS = 15 * 60 * 1000;
export const SNOOZE_MS = 10 * 60 * 1000;
export const ALERT_PAGE_SIZE = 50;
/**
 * BD-8: janela inferior da busca. Atividade vencida há mais de 7 dias e
 * nunca concluída não vira alerta — antes a paginação varria TODAS as
 * vencidas da org (sem limite inferior) a cada GET e a cada tick do push.
 * Override: `ACTIVITY_ALERT_LOOKBACK_MS`.
 */
export const ALERT_LOOKBACK_MS = (() => {
  const raw = Number(process.env.ACTIVITY_ALERT_LOOKBACK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7 * 24 * 60 * 60 * 1000;
})();
/** Teto de páginas por chamada (páginas × ALERT_PAGE_SIZE atividades). */
export const ALERT_MAX_PAGES = 10;

export type AlertKind = "PRE_DUE" | "DUE";

export type ActivityAlertDto = {
  id: string;
  kind: AlertKind;
  title: string;
  type: string;
  scheduledAt: string;
  contact?: { id: string; name: string } | null;
  deal?: { id: string; title: string } | null;
  department?: { id: string; name: string } | null;
};

function notifyActivityAlertPush(userId: string, alert: ActivityAlertDto): void {
  void import("@/lib/web-push")
    .then(({ sendPushToUser }) =>
      sendPushToUser(userId, {
        title:
          alert.kind === "PRE_DUE" ? "Tarefa em 15 minutos" : "Tarefa no horário",
        body: alert.title,
        url: "/activities",
        tag: `activity:${alert.id}`,
        renotify: true,
        data: { activityId: alert.id, kind: alert.kind },
      }),
    )
    .catch((err) => {
      log.error({ err }, "[activity-alerts] push failed (non-fatal)");
    });
}

export type AlertStateSnapshot = {
  id?: string;
  scheduledFor: Date;
  preDueShownAt: Date | null;
  dueShownAt: Date | null;
  snoozedUntil: Date | null;
  snoozedKind: AlertKind | null;
  dismissedAt: Date | null;
};

export type AlertActivitySnapshot = {
  id: string;
  organizationId: string;
  title: string;
  type: string;
  completed: boolean;
  scheduledAt: Date | null;
  userId: string | null;
  departmentId: string | null;
  contact?: { id: string; name: string } | null;
  deal?: { id: string; title: string } | null;
  department?: { id: string; name: string } | null;
};

export type Clock = () => Date;

const defaultClock: Clock = () => new Date();

export function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

/** Usuário é destinatário atual (assignee e/ou membro do depto). */
export function isActivityAlertRecipient(
  activity: { userId: string | null; departmentId: string | null },
  userId: string,
  departmentIds: readonly string[],
): boolean {
  if (activity.userId != null && activity.userId === userId) return true;
  if (
    activity.departmentId != null &&
    departmentIds.includes(activity.departmentId)
  ) {
    return true;
  }
  return false;
}

export function needsAlertStateReset(
  state: AlertStateSnapshot | null | undefined,
  scheduledAt: Date,
): boolean {
  if (!state) return false;
  return state.scheduledFor.getTime() !== scheduledAt.getTime();
}

export function resetAlertStateFields(scheduledFor: Date): AlertStateSnapshot {
  return {
    scheduledFor,
    preDueShownAt: null,
    dueShownAt: null,
    snoozedUntil: null,
    snoozedKind: null,
    dismissedAt: null,
  };
}

/**
 * Avalia se o alerta é elegível agora e qual kind entregar.
 * Assume state já normalizado p/ scheduledAt atual (ou null = sem entrega prévia).
 */
export function evaluateAlertKind(
  activity: { completed: boolean; scheduledAt: Date | null },
  state: AlertStateSnapshot | null | undefined,
  now: Date,
): AlertKind | null {
  if (activity.completed) return null;
  if (activity.scheduledAt == null) return null;

  const scheduledAt = activity.scheduledAt;
  const effective = state ?? null;

  if (effective?.dismissedAt) return null;

  if (
    effective?.snoozedUntil != null &&
    effective.snoozedUntil.getTime() > now.getTime()
  ) {
    return null;
  }

  const nowMs = now.getTime();
  const dueMs = scheduledAt.getTime();

  if (nowMs >= dueMs) {
    if (effective?.dueShownAt) return null;
    return "DUE";
  }

  const preStartMs = dueMs - PRE_DUE_WINDOW_MS;
  if (nowMs >= preStartMs && nowMs < dueMs) {
    if (effective?.preDueShownAt) return null;
    return "PRE_DUE";
  }

  return null;
}

/**
 * Snooze só do kind efetivamente mostrado e temporalmente compatível.
 * PRE_DUE: preDueShownAt set + now < scheduledAt
 * DUE: dueShownAt set + now >= scheduledAt
 */
export function canSnoozeKind(
  kind: AlertKind,
  state: AlertStateSnapshot,
  scheduledAt: Date,
  now: Date,
): boolean {
  if (state.dismissedAt) return false;
  if (kind === "PRE_DUE") {
    return state.preDueShownAt != null && now.getTime() < scheduledAt.getTime();
  }
  return state.dueShownAt != null && now.getTime() >= scheduledAt.getTime();
}

export type AlertCandidate = {
  activity: AlertActivitySnapshot;
  kind: AlertKind;
  state: AlertStateSnapshot | null;
};

/** DUE mais antigos primeiro; depois PRE_DUE mais próximos do vencimento. */
export function compareAlertCandidates(a: AlertCandidate, b: AlertCandidate): number {
  if (a.kind !== b.kind) {
    return a.kind === "DUE" ? -1 : 1;
  }
  const aAt = a.activity.scheduledAt!.getTime();
  const bAt = b.activity.scheduledAt!.getTime();
  if (aAt !== bAt) return aAt - bAt;
  return a.activity.id < b.activity.id ? -1 : a.activity.id > b.activity.id ? 1 : 0;
}

export function pickNextAlertCandidate(
  candidates: AlertCandidate[],
): AlertCandidate | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort(compareAlertCandidates);
  return sorted[0] ?? null;
}

export function buildAlertDto(
  activity: AlertActivitySnapshot,
  kind: AlertKind,
): ActivityAlertDto {
  return {
    id: activity.id,
    kind,
    title: activity.title,
    type: activity.type,
    scheduledAt: activity.scheduledAt!.toISOString(),
    contact: activity.contact ?? null,
    deal: activity.deal ?? null,
    department: activity.department ?? null,
  };
}

export function applyDismissToState(
  _state: AlertStateSnapshot,
  now: Date,
): Partial<AlertStateSnapshot> {
  return {
    dismissedAt: now,
    snoozedUntil: null,
    snoozedKind: null,
  };
}

/**
 * Snooze: reapresentar após exatamente 10 min.
 * Limpa o shown do kind para permitir reentrega; se PRE_DUE atravessar
 * scheduledAt, evaluateAlertKind passa a retornar DUE.
 */
export function applySnoozeToState(
  kind: AlertKind,
  now: Date,
): Partial<AlertStateSnapshot> & { snoozedUntil: Date; snoozedKind: AlertKind } {
  const patch: Partial<AlertStateSnapshot> & {
    snoozedUntil: Date;
    snoozedKind: AlertKind;
  } = {
    snoozedUntil: new Date(now.getTime() + SNOOZE_MS),
    snoozedKind: kind,
  };
  if (kind === "PRE_DUE") {
    patch.preDueShownAt = null;
  } else {
    patch.dueShownAt = null;
  }
  return patch;
}

function normalizeState(
  state: AlertStateSnapshot | null,
  scheduledAt: Date,
): AlertStateSnapshot | null {
  if (!state) return null;
  if (needsAlertStateReset(state, scheduledAt)) {
    return resetAlertStateFields(scheduledAt);
  }
  return state;
}

function toActivitySnapshot(row: {
  id: string;
  organizationId: string;
  title: string;
  type: string;
  completed: boolean;
  scheduledAt: Date | null;
  userId: string | null;
  departmentId: string | null;
  contact?: { id: string; name: string } | null;
  deal?: { id: string; title: string } | null;
  department?: { id: string; name: string } | null;
}): AlertActivitySnapshot {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    type: row.type,
    completed: row.completed,
    scheduledAt: row.scheduledAt,
    userId: row.userId,
    departmentId: row.departmentId,
    contact: row.contact ?? null,
    deal: row.deal ?? null,
    department: row.department ?? null,
  };
}

const activityInclude = {
  contact: { select: { id: true, name: true } },
  deal: { select: { id: true, title: true } },
  department: { select: { id: true, name: true } },
} as const;

type AlertStateRow = AlertStateSnapshot & { id: string; activityId: string; userId: string };

type DbClient = {
  activity: {
    findFirst: (args: unknown) => Promise<AlertActivitySnapshot | null>;
    findMany: (args: unknown) => Promise<AlertActivitySnapshot[]>;
  };
  activityAlertState: {
    findUnique: (args: unknown) => Promise<AlertStateRow | null>;
    findMany: (args: unknown) => Promise<AlertStateRow[]>;
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
};

/** Where otimista: só um caller marca shown (ou reset+claim no reagendar). */
export function buildOptimisticClaimWhere(args: {
  id: string;
  kind: AlertKind;
  scheduledFor: Date;
  now: Date;
  mode: "normal" | "reschedule";
  previousScheduledFor?: Date;
}): Record<string, unknown> {
  if (args.mode === "reschedule") {
    return {
      id: args.id,
      scheduledFor: args.previousScheduledFor,
    };
  }
  const shownField = args.kind === "PRE_DUE" ? "preDueShownAt" : "dueShownAt";
  return {
    id: args.id,
    scheduledFor: args.scheduledFor,
    dismissedAt: null,
    [shownField]: null,
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: args.now } }],
  };
}

async function claimAlertDelivery(
  db: DbClient,
  userId: string,
  organizationId: string,
  departmentIds: readonly string[],
  candidate: AlertCandidate,
  now: Date,
): Promise<ActivityAlertDto | null> {
  const activity = await db.activity.findFirst({
    where: {
      id: candidate.activity.id,
      organizationId,
      completed: false,
      scheduledAt: { not: null },
    },
    include: activityInclude,
  });
  if (!activity?.scheduledAt) return null;

  const snap = toActivitySnapshot(activity);
  if (!isActivityAlertRecipient(snap, userId, departmentIds)) return null;

  const existing = await db.activityAlertState.findUnique({
    where: {
      activityId_userId: { activityId: snap.id, userId },
    },
  });

  const wasRescheduled =
    existing != null && needsAlertStateReset(existing, snap.scheduledAt!);
  const effective = normalizeState(existing, snap.scheduledAt!);
  const kind = evaluateAlertKind(snap, effective, now);
  if (!kind) return null;

  const shownField = kind === "PRE_DUE" ? "preDueShownAt" : "dueShownAt";

  if (!existing) {
    try {
      await db.activityAlertState.create({
        data: {
          organizationId,
          activityId: snap.id,
          userId,
          scheduledFor: snap.scheduledAt!,
          [shownField]: now,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) return null;
      throw err;
    }
    return buildAlertDto(snap, kind);
  }

  if (wasRescheduled) {
    const result = await db.activityAlertState.updateMany({
      where: buildOptimisticClaimWhere({
        id: existing.id,
        kind,
        scheduledFor: snap.scheduledAt!,
        now,
        mode: "reschedule",
        previousScheduledFor: existing.scheduledFor,
      }),
      data: {
        scheduledFor: snap.scheduledAt!,
        preDueShownAt: kind === "PRE_DUE" ? now : null,
        dueShownAt: kind === "DUE" ? now : null,
        snoozedUntil: null,
        snoozedKind: null,
        dismissedAt: null,
      },
    });
    if (result.count !== 1) return null;
    return buildAlertDto(snap, kind);
  }

  const result = await db.activityAlertState.updateMany({
    where: buildOptimisticClaimWhere({
      id: existing.id,
      kind,
      scheduledFor: snap.scheduledAt!,
      now,
      mode: "normal",
    }),
    data: {
      [shownField]: now,
      snoozedUntil: null,
      snoozedKind: null,
    },
  });
  if (result.count !== 1) return null;
  return buildAlertDto(snap, kind);
}

type PageCursor = { scheduledAt: Date; id: string };

function buildRecipientOr(userId: string, departmentIds: readonly string[]) {
  const orFilters: Array<Record<string, unknown>> = [{ userId }];
  if (departmentIds.length) {
    orFilters.push({ departmentId: { in: [...departmentIds] } });
  }
  return orFilters;
}

export type GetNextActivityAlertOptions = {
  now?: Date;
  clock?: Clock;
  pageSize?: number;
  /** Teto de páginas; default `ALERT_MAX_PAGES`. */
  maxPages?: number;
  /**
   * Restringe a busca a estas atividades (sweeper de push: candidatas já
   * filtradas por org com NOT EXISTS em `activity_alert_states`).
   */
  activityIds?: readonly string[];
};

/**
 * GET: no máximo um alerta. Claim otimista; paginação evita starvation.
 * Horizonte: now - ALERT_LOOKBACK_MS <= scheduledAt <= now + 15min.
 */
export async function getNextActivityAlert(
  userId: string,
  organizationId: string,
  options?: GetNextActivityAlertOptions,
): Promise<ActivityAlertDto | null> {
  const now = options?.now ?? options?.clock?.() ?? defaultClock();
  const pageSize = options?.pageSize ?? ALERT_PAGE_SIZE;
  const maxPages = options?.maxPages ?? ALERT_MAX_PAGES;
  if (options?.activityIds && options.activityIds.length === 0) return null;
  const departmentIds = await getUserDepartmentIds(userId, organizationId);
  const horizonStart = new Date(now.getTime() - ALERT_LOOKBACK_MS);
  const horizonEnd = new Date(now.getTime() + PRE_DUE_WINDOW_MS);
  const recipientOr = buildRecipientOr(userId, departmentIds);

  let cursor: PageCursor | null = null;

  for (let page = 0; page < maxPages; page++) {
    const andFilters: Array<Record<string, unknown>> = [
      { OR: recipientOr },
    ];
    if (cursor) {
      andFilters.push({
        OR: [
          { scheduledAt: { gt: cursor.scheduledAt } },
          {
            AND: [
              { scheduledAt: cursor.scheduledAt },
              { id: { gt: cursor.id } },
            ],
          },
        ],
      });
    }

    const activities = await prisma.activity.findMany({
      where: {
        organizationId,
        completed: false,
        scheduledAt: { not: null, gte: horizonStart, lte: horizonEnd },
        ...(options?.activityIds
          ? { id: { in: [...options.activityIds] } }
          : {}),
        AND: andFilters,
      },
      include: activityInclude,
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take: pageSize,
    });

    if (!activities.length) return null;

    const states = await prisma.activityAlertState.findMany({
      where: {
        organizationId,
        userId,
        activityId: { in: activities.map((a) => a.id) },
      },
    });
    const stateByActivity = new Map(states.map((s) => [s.activityId, s]));

    const candidates: AlertCandidate[] = [];
    for (const row of activities) {
      const snap = toActivitySnapshot(row);
      if (!snap.scheduledAt) continue;
      if (!isActivityAlertRecipient(snap, userId, departmentIds)) continue;

      const rawState = stateByActivity.get(snap.id) ?? null;
      const effective = normalizeState(rawState, snap.scheduledAt);
      const kind = evaluateAlertKind(snap, effective, now);
      if (!kind) continue;
      candidates.push({
        activity: snap,
        kind,
        state: effective,
      });
    }

    candidates.sort(compareAlertCandidates);

    for (const candidate of candidates) {
      const claimed = await claimAlertDelivery(
        prisma as unknown as DbClient,
        userId,
        organizationId,
        departmentIds,
        candidate,
        now,
      );
      if (claimed) {
        void notifyActivityAlertPush(userId, claimed);
        return claimed;
      }
    }

    const last = activities[activities.length - 1];
    if (!last.scheduledAt || activities.length < pageSize) return null;
    cursor = { scheduledAt: last.scheduledAt, id: last.id };
  }
  // Teto de páginas: quem tem mais de maxPages × pageSize atividades na
  // janela sem nada entregável hoje não pode custar mais que isso por GET.
  return null;
}

export type AlertActionResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 404; message: string };

/**
 * POST dismiss | snooze. userId exclusivamente do auth.
 */
export async function applyActivityAlertAction(
  userId: string,
  organizationId: string,
  activityId: string,
  action: { action: "dismiss" } | { action: "snooze"; kind: AlertKind },
  options?: { now?: Date; clock?: Clock },
): Promise<AlertActionResult> {
  const now = options?.now ?? options?.clock?.() ?? defaultClock();
  const departmentIds = await getUserDepartmentIds(userId, organizationId);

  const activity = await prisma.activity.findFirst({
    where: { id: activityId, organizationId },
    select: {
      id: true,
      completed: true,
      scheduledAt: true,
      userId: true,
      departmentId: true,
    },
  });

  if (!activity) {
    return { ok: false, status: 404, message: "Atividade não encontrada." };
  }
  if (!isActivityAlertRecipient(activity, userId, departmentIds)) {
    return { ok: false, status: 403, message: "Você não é destinatário deste alerta." };
  }
  if (activity.completed || activity.scheduledAt == null) {
    return { ok: false, status: 400, message: "Atividade sem alerta elegível." };
  }

  const existing = await prisma.activityAlertState.findUnique({
    where: { activityId_userId: { activityId, userId } },
  });

  if (!existing) {
    return { ok: false, status: 404, message: "Estado de alerta não encontrado." };
  }

  if (needsAlertStateReset(existing, activity.scheduledAt)) {
    return {
      ok: false,
      status: 400,
      message: "Alerta desatualizado após reagendamento.",
    };
  }

  if (existing.dismissedAt) {
    return { ok: false, status: 400, message: "Alerta já foi dispensado." };
  }

  if (action.action === "dismiss") {
    await prisma.activityAlertState.update({
      where: { id: existing.id },
      data: applyDismissToState(existing, now),
    });
    return { ok: true };
  }

  if (!canSnoozeKind(action.kind, existing, activity.scheduledAt, now)) {
    return {
      ok: false,
      status: 400,
      message: "Snooze inválido para o kind/horário atual.",
    };
  }

  await prisma.activityAlertState.update({
    where: { id: existing.id },
    data: applySnoozeToState(action.kind, now),
  });
  return { ok: true };
}
