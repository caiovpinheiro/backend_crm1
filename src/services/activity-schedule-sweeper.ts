import type { ActivityType } from "@prisma/client";

import { enqueueAutomationJob } from "@/lib/queue";
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { getLogger } from "@/lib/logger";
import { scheduleBackgroundTimeout, scheduleBackgroundInterval } from "@/lib/background-timers";
import {
  activityScheduleRange,
  buildActivityScheduleClaimKey,
  normalizeActivityScheduleConfig,
} from "@/lib/activity-schedule-trigger";

const log = getLogger("activity-schedule-sweeper");

const INTERVAL_MS = Number(process.env.AUTOMATION_ACTIVITY_SCHEDULE_INTERVAL_MS) || 60_000;
const TZ = "America/Sao_Paulo";
let started = false;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function formatBr(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replace(",", "");
}

export function startActivityScheduleSweeper(): void {
  if (started || process.env.AUTOMATION_ACTIVITY_SCHEDULE_SWEEPER === "0") return;
  started = true;

  const tick = () => {
    void sweepActivityScheduleTriggers().catch((error) => {
      log.warn(
        { err: error instanceof Error ? error.message : error },
        "[activity-schedule] tick falhou",
      );
    });
  };
  scheduleBackgroundTimeout(() => {
    tick();
    scheduleBackgroundInterval(tick, INTERVAL_MS);
  }, 25_000);
  log.info({ tickMs: INTERVAL_MS }, "[activity-schedule] sweeper iniciado");
}

/**
 * Para cada automação ativa com gatilho `activity_scheduled`, busca as
 * tarefas cujo momento de disparo (scheduledAt ± deslocamento) acabou de
 * passar e enfileira uma execução. O claim único (automação + tarefa +
 * horário) impede repetição entre ticks e réplicas.
 */
export async function sweepActivityScheduleTriggers(
  now = new Date(),
): Promise<{ candidates: number; claimed: number }> {
  const automations = await prismaBase.automation.findMany({
    where: { active: true, triggerType: "activity_scheduled" },
    select: { id: true, organizationId: true, triggerConfig: true },
  });

  let candidates = 0;
  let claimed = 0;
  for (const automation of automations) {
    const cfg = normalizeActivityScheduleConfig(automation.triggerConfig);
    if (!cfg) continue;
    const range = activityScheduleRange(cfg.offsetMs, now);

    const activities = await prismaBase.activity.findMany({
      where: {
        organizationId: automation.organizationId,
        scheduledAt: { gt: range.gt, lte: range.lte },
        ...(cfg.includeCompleted ? {} : { completed: false }),
        ...(cfg.activityType ? { type: cfg.activityType as ActivityType } : {}),
      },
      select: {
        id: true,
        type: true,
        title: true,
        description: true,
        scheduledAt: true,
        completed: true,
        contactId: true,
        dealId: true,
        userId: true,
        departmentId: true,
        createdById: true,
        visibleToAll: true,
        user: { select: { name: true } },
      },
      take: 500,
    });
    candidates += activities.length;

    for (const activity of activities) {
      if (!activity.scheduledAt) continue;
      try {
        await prismaBase.automationActivityScheduleClaim.create({
          data: {
            id: buildActivityScheduleClaimKey(automation.id, activity.id, activity.scheduledAt),
            organizationId: automation.organizationId,
            automationId: automation.id,
            activityId: activity.id,
            scheduledAt: activity.scheduledAt,
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }

      claimed++;
      await withSystemContext(automation.organizationId, () =>
        enqueueAutomationJob({
          automationId: automation.id,
          context: {
            event: "activity_scheduled",
            contactId: activity.contactId ?? undefined,
            dealId: activity.dealId ?? undefined,
            data: {
              activityId: activity.id,
              activityType: activity.type,
              activityTitle: activity.title,
              activityDescription: activity.description ?? "",
              activityScheduledAt: activity.scheduledAt.toISOString(),
              activityScheduledAtFormatted: formatBr(activity.scheduledAt),
              activityCompleted: activity.completed,
              activityAssigneeUserId: activity.userId,
              activityAssigneeName: activity.user?.name ?? "",
              activityDepartmentId: activity.departmentId,
              activityCreatedById: activity.createdById,
              activityVisibleToAll: activity.visibleToAll,
              timing: cfg.timing,
              offsetAmount: cfg.offsetAmount,
              offsetUnit: cfg.offsetUnit,
            },
          },
        }),
      );
    }
  }
  return { candidates, claimed };
}
