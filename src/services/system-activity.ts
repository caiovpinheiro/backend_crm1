/**
 * Serviço de USO REAL do CRM.
 *
 * Diferente de `system-presence` (heartbeat de "aba aberta"), este serviço
 * mede blocos de atividade humana visível — cada pulso enviado pelo cliente
 * só chega aqui quando o usuário efetivamente interagiu com a interface
 * (documento visível + ação real: click em controle interativo, digitação,
 * change, submit, navegação de rota). Cf. spec 2026-07-26-system-usage-logs.
 *
 * Modelo: `SystemActivitySession`. Partial unique
 * `(organizationId, userId) WHERE endedAt IS NULL` garante no máximo
 * uma sessão aberta por (org, usuário). O sweeper fecha em
 * `lastActivityAt + 5 minutos` sessões cuja janela expirou.
 */

import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";
import { scheduleBackgroundTimeout, scheduleBackgroundInterval } from "@/lib/background-timers";

const log = getLogger("system-activity");

/** Janela de inatividade: 5 minutos. */
export const SYSTEM_ACTIVITY_IDLE_MS = 5 * 60_000;

/** Cadência mínima esperada de pulso do cliente (30s). */
export const SYSTEM_ACTIVITY_MIN_PULSE_MS = 30_000;

/** Cap de segurança de interações por pulso (evita inflar contador). */
export const SYSTEM_ACTIVITY_MAX_INTERACTIONS_PER_PULSE = 500;

/** Tick do sweeper (1 min). */
const SWEEP_INTERVAL_MS = 60_000;

/** Boot delay para não colidir com outros sweepers no arranque. */
const SWEEP_BOOT_DELAY_MS = 15_000;

let sweeperStarted = false;

// ── Helpers puros (testáveis sem DB) ────────────────────────────────

/** Fim natural de uma sessão baseada na última atividade + idle. */
export function activityEnd(lastActivityAt: Date): Date {
  return new Date(lastActivityAt.getTime() + SYSTEM_ACTIVITY_IDLE_MS);
}

/**
 * Sobreposição [startedAt, endedAt) com janela [from, to).
 * Convenção padrão de intervalos semiabertos.
 */
export function overlapsWindow(
  startedAt: Date,
  endedAt: Date,
  from: Date,
  to: Date,
): boolean {
  return startedAt < to && endedAt > from;
}

/**
 * Renova a sessão atual quando o intervalo até a nova ação ≤ idle.
 * Se passou do idle, o sweeper (ou o próprio path de gravação)
 * deve fechar a sessão e criar uma nova.
 */
export function shouldRenewSession(lastActivityAt: Date, at: Date): boolean {
  return at.getTime() - lastActivityAt.getTime() <= SYSTEM_ACTIVITY_IDLE_MS;
}

/** Limita o contador recebido do cliente ao intervalo válido 1..500. */
export function clampInteractionCount(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > SYSTEM_ACTIVITY_MAX_INTERACTIONS_PER_PULSE) {
    return SYSTEM_ACTIVITY_MAX_INTERACTIONS_PER_PULSE;
  }
  return n;
}

/**
 * Fim efetivo de uma sessão para relatório dentro de [from, to].
 *   - Sessão fechada: usa `endedAt` (recortado pelo `to`).
 *   - Sessão aberta:  min(lastActivityAt + 5m, now, to).
 */
export function effectiveSessionEnd(
  _startedAt: Date,
  lastActivityAt: Date,
  endedAt: Date | null,
  now: Date,
  to: Date,
): Date {
  if (endedAt) {
    return endedAt < to ? endedAt : to;
  }
  const idleEnd = new Date(lastActivityAt.getTime() + SYSTEM_ACTIVITY_IDLE_MS);
  const candidates = [idleEnd.getTime(), now.getTime(), to.getTime()];
  return new Date(Math.min(...candidates));
}

/**
 * Retorna a interseção em segundos entre `[startedAt, endedAt]` e
 * `[from, to]`. Zero quando não há sobreposição.
 */
export function intersectSeconds(
  startedAt: Date,
  endedAt: Date,
  from: Date,
  to: Date,
): number {
  const start = Math.max(startedAt.getTime(), from.getTime());
  const end = Math.min(endedAt.getTime(), to.getTime());
  if (end <= start) return 0;
  return Math.round((end - start) / 1000);
}

// ── Gravação transacional ───────────────────────────────────────────

export interface RecordActivityInput {
  organizationId: string;
  userId: string;
  interactionCount: number;
  at?: Date;
}

export interface RecordActivityResult {
  sessionId: string;
  created: boolean;
}

/**
 * Registra um pulso de atividade:
 *   - Se existe sessão aberta e `at - lastActivityAt <= 5m`: atualiza
 *     `lastActivityAt` e soma `interactionCount`.
 *   - Se existe sessão aberta mas expirou: fecha em `lastActivityAt+5m`
 *     e cria nova sessão.
 *   - Se não há sessão aberta: cria uma.
 *
 * `SystemUsageSession` NUNCA é tocado por este serviço — presença ao
 * vivo continua independente.
 */
export async function recordSystemActivity(
  input: RecordActivityInput,
): Promise<RecordActivityResult> {
  const { organizationId, userId } = input;
  const at = input.at ?? new Date();
  const count = clampInteractionCount(input.interactionCount);

  const open = await prismaBase.systemActivitySession.findFirst({
    where: { organizationId, userId, endedAt: null },
    select: { id: true, lastActivityAt: true },
  });

  if (open) {
    if (shouldRenewSession(open.lastActivityAt, at)) {
      await prismaBase.systemActivitySession.update({
        where: { id: open.id },
        data: {
          lastActivityAt: at,
          interactionCount: { increment: count },
        },
      });
      return { sessionId: open.id, created: false };
    }

    // Sessão expirou: fecha em last+5m e cria nova.
    const closedEnd = activityEnd(open.lastActivityAt);
    await prismaBase.systemActivitySession.update({
      where: { id: open.id },
      data: { endedAt: closedEnd },
    });
  }

  try {
    const created = await prismaBase.systemActivitySession.create({
      data: {
        organizationId,
        userId,
        startedAt: at,
        lastActivityAt: at,
        interactionCount: count,
      },
      select: { id: true },
    });
    return { sessionId: created.id, created: true };
  } catch (err) {
    // Race entre abas: partial unique disparou. Faz update na aberta.
    if ((err as { code?: string }).code === "P2002") {
      const race = await prismaBase.systemActivitySession.findFirst({
        where: { organizationId, userId, endedAt: null },
        select: { id: true },
      });
      if (race) {
        await prismaBase.systemActivitySession.update({
          where: { id: race.id },
          data: {
            lastActivityAt: at,
            interactionCount: { increment: count },
          },
        });
        return { sessionId: race.id, created: false };
      }
    }
    throw err;
  }
}

// ── Sweeper ─────────────────────────────────────────────────────────

/**
 * Fecha sessões abertas cuja última atividade passou de `IDLE_MS`.
 * `endedAt = lastActivityAt + 5 minutos`.
 */
export async function sweepInactiveActivitySessions(): Promise<{
  closed: number;
}> {
  const cutoff = new Date(Date.now() - SYSTEM_ACTIVITY_IDLE_MS);
  const closed = await prismaBase.$queryRaw<{ id: string }[]>`
    WITH updated AS (
      UPDATE "system_activity_sessions"
      SET "endedAt" = "lastActivityAt" + INTERVAL '5 minutes',
          "updatedAt" = NOW()
      WHERE "endedAt" IS NULL
        AND "lastActivityAt" < ${cutoff}
      RETURNING "id"
    )
    SELECT "id" FROM updated
  `;
  return { closed: closed.length };
}

export function startSystemActivitySweeper() {
  if (sweeperStarted) return;
  sweeperStarted = true;

  const tick = async () => {
    try {
      await sweepInactiveActivitySessions();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[system-activity] sweeper falhou",
      );
    }
  };

  scheduleBackgroundTimeout(() => {
    void tick();
    scheduleBackgroundInterval(() => void tick(), SWEEP_INTERVAL_MS);
  }, SWEEP_BOOT_DELAY_MS);

  log.info(
    { idleMs: SYSTEM_ACTIVITY_IDLE_MS, tickMs: SWEEP_INTERVAL_MS },
    "[system-activity] sweeper iniciado",
  );
}

// ── Agregação por usuário ───────────────────────────────────────────

export interface SystemActivityAggregateRow {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  avatarUrl: string | null;
  activeNow: boolean;
  lastActivityAt: string | null;
  totalSeconds: number;
  sessionCount: number;
  averageSessionSeconds: number;
  interactionCount: number;
}

export async function getSystemActivityAggregate(params: {
  organizationId: string;
  from: Date;
  to: Date;
}): Promise<SystemActivityAggregateRow[]> {
  const { organizationId, from, to } = params;

  const rows = await prismaBase.$queryRaw<
    {
      userId: string;
      name: string | null;
      email: string | null;
      avatarUrl: string | null;
      total_seconds: bigint | number | string | null;
      session_count: bigint | number | string | null;
      interaction_count: bigint | number | string | null;
      last_activity_at: Date | null;
      active_now: boolean | null;
    }[]
  >`
    WITH s AS (
      SELECT
        s."userId",
        s."interactionCount",
        s."lastActivityAt",
        s."endedAt" IS NULL AS is_open,
        GREATEST(s."startedAt", ${from}) AS eff_start,
        LEAST(
          COALESCE(
            s."endedAt",
            LEAST(s."lastActivityAt" + INTERVAL '5 minutes', NOW())
          ),
          ${to}
        ) AS eff_end
      FROM "system_activity_sessions" s
      WHERE s."organizationId" = ${organizationId}
        AND s."startedAt" < ${to}
        AND (
          s."endedAt" IS NULL
          OR s."endedAt" > ${from}
        )
    )
    SELECT
      u."id" AS "userId",
      u."name" AS name,
      u."email" AS email,
      u."avatarUrl" AS "avatarUrl",
      COALESCE(SUM(
        GREATEST(EXTRACT(EPOCH FROM (s.eff_end - s.eff_start)), 0)
      ), 0)::bigint AS total_seconds,
      COUNT(s.*)::int AS session_count,
      COALESCE(SUM(s."interactionCount"), 0)::bigint AS interaction_count,
      MAX(s."lastActivityAt") AS last_activity_at,
      BOOL_OR(COALESCE(s.is_open, false)) AS active_now
    FROM "users" u
    LEFT JOIN s ON s."userId" = u."id"
    WHERE u."organizationId" = ${organizationId}
    GROUP BY u."id", u."name", u."email", u."avatarUrl"
    HAVING COUNT(s.*) > 0
    ORDER BY active_now DESC, last_activity_at DESC NULLS LAST, u."name" ASC
  `;

  return rows.map((r) => {
    const total = Number(r.total_seconds ?? 0);
    const count = Number(r.session_count ?? 0);
    const last = r.last_activity_at ? new Date(r.last_activity_at) : null;
    return {
      userId: r.userId,
      userName: r.name,
      userEmail: r.email,
      avatarUrl: r.avatarUrl,
      activeNow: Boolean(r.active_now),
      lastActivityAt: last ? last.toISOString() : null,
      totalSeconds: total,
      sessionCount: count,
      averageSessionSeconds: count > 0 ? Math.round(total / count) : 0,
      interactionCount: Number(r.interaction_count ?? 0),
    };
  });
}

// ── Sessões paginadas ───────────────────────────────────────────────

export interface SystemActivitySessionItem {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  interactionCount: number;
  isOpen: boolean;
}

export interface ListSystemActivitySessionsResult {
  items: SystemActivitySessionItem[];
  nextCursor: string | null;
}

const SESSIONS_MAX_LIMIT = 50;

export async function listSystemActivitySessions(params: {
  organizationId: string;
  userId: string;
  from: Date;
  to: Date;
  cursor?: string | null;
  limit?: number;
}): Promise<ListSystemActivitySessionsResult> {
  const { organizationId, userId, from, to } = params;
  const limit = Math.min(
    Math.max(1, params.limit ?? SESSIONS_MAX_LIMIT),
    SESSIONS_MAX_LIMIT,
  );

  const rows = await prismaBase.systemActivitySession.findMany({
    where: {
      organizationId,
      userId,
      startedAt: { lt: to },
      OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      ...(params.cursor ? { id: { lt: params.cursor } } : {}),
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      startedAt: true,
      lastActivityAt: true,
      endedAt: true,
      interactionCount: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const now = new Date();

  const items: SystemActivitySessionItem[] = page.map((r) => {
    const effEnd = effectiveSessionEnd(
      r.startedAt,
      r.lastActivityAt,
      r.endedAt,
      now,
      to,
    );
    const effStart = r.startedAt < from ? from : r.startedAt;
    const duration = Math.max(
      0,
      Math.round((effEnd.getTime() - effStart.getTime()) / 1000),
    );
    return {
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      endedAt: effEnd.toISOString(),
      durationSeconds: duration,
      interactionCount: r.interactionCount,
      isOpen: r.endedAt === null,
    };
  });

  return {
    items,
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
