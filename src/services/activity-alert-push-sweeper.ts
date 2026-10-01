/**
 * Dispara avisos de tarefa via FCM mesmo com o CRM fechado.
 * Só itera usuários com token nativo (endpoint fcm:) para não "roubar"
 * o popup interno de quem só usa desktop.
 *
 * BD-8 — custo por tick. Antes: para CADA usuário com assinatura, a cada
 * 60 s, `getNextActivityAlert` paginava todas as atividades vencidas da
 * org sem limite inferior (6 páginas × 2 queries por usuário com 300
 * vencidas). Agora:
 *   1. UMA consulta por org devolve só pares (usuário, atividade) com
 *      alerta ainda não entregue (`NOT EXISTS` em `activity_alert_states`),
 *      janela `now - ALERT_LOOKBACK_MS .. now + 15 min`, teto de linhas;
 *   2. `getNextActivityAlert` roda só para quem tem candidata, restrito a
 *      esses ids (uma página) — o claim otimista e o push continuam lá;
 *   3. tick de 300 s (override `ACTIVITY_ALERT_PUSH_INTERVAL_MS`).
 */
import { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { FCM_ENDPOINT_PREFIX, isFcmConfigured } from "@/lib/fcm";
import {
  ALERT_LOOKBACK_MS,
  PRE_DUE_WINDOW_MS,
  getNextActivityAlert,
} from "@/services/activity-alerts";
import { getLogger } from "@/lib/logger";
import { scheduleBackgroundTimeout, scheduleBackgroundInterval } from "@/lib/background-timers";

const log = getLogger("activity-alert-push-sweeper");

const INTERVAL_MS =
  Number(process.env.ACTIVITY_ALERT_PUSH_INTERVAL_MS) || 300_000;
/** Teto de pares (usuário, atividade) por org por tick. */
export const PUSH_CANDIDATE_LIMIT = 500;
/** Pushes por usuário por tick — evita starvation sem drenar tudo de uma vez. */
export const PUSH_MAX_PER_USER_PER_TICK = 5;
let started = false;

export function startActivityAlertPushSweeper(): void {
  if (started) return;
  if (process.env.ACTIVITY_ALERT_PUSH_SWEEPER === "0") return;
  started = true;

  const tick = () => {
    void sweepActivityAlertPushes().catch((error) => {
      log.warn(
        { err: error instanceof Error ? error.message : error },
        "[activity-alert-push] tick falhou",
      );
    });
  };
  scheduleBackgroundTimeout(() => {
    tick();
    scheduleBackgroundInterval(tick, INTERVAL_MS);
  }, 30_000);
  log.info(
    { tickMs: INTERVAL_MS, fcm: isFcmConfigured() ? "configurado" : "AUSENTE" },
    "[activity-alert-push] sweeper iniciado",
  );
}

type CandidateRow = { userId: string; activityId: string };

/**
 * Pares (usuário, atividade) da org com alerta entregável agora e ainda
 * não entregue. Espelha `evaluateAlertKind`: fora quando o estado (para o
 * mesmo `scheduledFor`) está dispensado, com DUE já mostrado, adiado para
 * o futuro, ou com PRE_DUE já mostrado antes do vencimento. Estado com
 * `scheduledFor` divergente (reagendada) não conta — precisa reentregar.
 */
export async function listUndeliveredAlertCandidates(
  organizationId: string,
  userIds: readonly string[],
  now: Date,
  limit = PUSH_CANDIDATE_LIMIT,
): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (userIds.length === 0) return byUser;
  const since = new Date(now.getTime() - ALERT_LOOKBACK_MS);
  const horizon = new Date(now.getTime() + PRE_DUE_WINDOW_MS);
  const ids = Prisma.join([...userIds]);

  const rows = await prismaBase.$queryRaw<
    Array<CandidateRow & { scheduledAt: Date }>
  >`
    SELECT DISTINCT
      r.user_id AS "userId",
      a.id AS "activityId",
      a."scheduledAt" AS "scheduledAt"
    FROM "activities" a
    JOIN LATERAL (
      SELECT a."userId" AS user_id
      WHERE a."userId" IN (${ids})
      UNION
      SELECT dm."userId" AS user_id
      FROM "department_members" dm
      WHERE a."departmentId" IS NOT NULL
        AND dm."departmentId" = a."departmentId"
        AND dm."organizationId" = a."organizationId"
        AND dm."userId" IN (${ids})
    ) r ON true
    WHERE a."organizationId" = ${organizationId}
      AND a.completed = false
      AND a."scheduledAt" IS NOT NULL
      AND a."scheduledAt" >= ${since}
      AND a."scheduledAt" <= ${horizon}
      AND NOT EXISTS (
        SELECT 1
        FROM "activity_alert_states" s
        WHERE s."activityId" = a.id
          AND s."userId" = r.user_id
          AND s."scheduledFor" = a."scheduledAt"
          AND (
            s."dismissedAt" IS NOT NULL
            OR s."dueShownAt" IS NOT NULL
            OR (s."snoozedUntil" IS NOT NULL AND s."snoozedUntil" > ${now})
            OR (s."preDueShownAt" IS NOT NULL AND a."scheduledAt" > ${now})
          )
      )
    ORDER BY a."scheduledAt" ASC
    LIMIT ${limit}
  `;

  for (const row of rows) {
    const list = byUser.get(row.userId);
    if (list) list.push(row.activityId);
    else byUser.set(row.userId, [row.activityId]);
  }
  return byUser;
}

export async function sweepActivityAlertPushes(
  now: Date = new Date(),
): Promise<{ users: number; orgs: number; candidates: number; delivered: number }> {
  const subs = await prismaBase.webPushSubscription.findMany({
    where: {
      failedAt: null,
      endpoint: { startsWith: FCM_ENDPOINT_PREFIX },
    },
    select: { userId: true, organizationId: true },
    distinct: ["userId", "organizationId"],
  });

  const usersByOrg = new Map<string, Set<string>>();
  for (const sub of subs) {
    const set = usersByOrg.get(sub.organizationId) ?? new Set<string>();
    set.add(sub.userId);
    usersByOrg.set(sub.organizationId, set);
  }

  let candidates = 0;
  let delivered = 0;
  for (const [organizationId, users] of usersByOrg) {
    let byUser: Map<string, string[]>;
    try {
      byUser = await listUndeliveredAlertCandidates(
        organizationId,
        [...users],
        now,
      );
    } catch (error) {
      log.warn(
        { organizationId, err: error instanceof Error ? error.message : error },
        "[activity-alert-push] falha ao listar candidatas da org",
      );
      continue;
    }

    for (const [userId, activityIds] of byUser) {
      candidates += activityIds.length;
      // getNextActivityAlert usa o prisma com escopo de tenant, que exige
      // RequestContext. Sem isto o worker morre no primeiro usuario e ninguem
      // recebe aviso com o app fechado.
      try {
        await withSystemContext(organizationId, async () => {
          const remaining = new Set(activityIds);
          for (
            let i = 0;
            i < PUSH_MAX_PER_USER_PER_TICK && remaining.size > 0;
            i++
          ) {
            const alert = await getNextActivityAlert(userId, organizationId, {
              now,
              activityIds: [...remaining],
            });
            if (!alert) break;
            delivered++;
            remaining.delete(alert.id);
          }
        });
      } catch (error) {
        log.warn(
          { userId, err: error instanceof Error ? error.message : error },
          "[activity-alert-push] falha no usuario",
        );
      }
    }
  }
  return { users: subs.length, orgs: usersByOrg.size, candidates, delivered };
}
