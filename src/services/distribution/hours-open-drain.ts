/**
 * Agenda / cancela o drain atrasado no próximo expediente (`hours_open`).
 */
import {
  cancelHoursOpenDrain,
  enqueueHoursOpenDrain,
} from "@/lib/distribution-drain-queue";
import { debugInfo } from "@/lib/debug-log";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";

import {
  hoursOpenConsultantsFromResponsibles,
  nextHoursOpenAt,
  type HoursOpenConsultant,
} from "./hours-open";
import { getWaitingQueueWhere } from "./pending-shared";
import type { DistributionResponsibleView } from "./responsibles";

export function consultantsForHoursOpen(
  views: DistributionResponsibleView[],
): HoursOpenConsultant[] {
  return hoursOpenConsultantsFromResponsibles(views);
}

export async function syncHoursOpenDrain(opts: {
  pending: number;
  consultants: HoursOpenConsultant[];
}): Promise<void> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return;

  try {
    if (opts.pending <= 0) {
      await cancelHoursOpenDrain(orgId);
      return;
    }

    const next = nextHoursOpenAt(opts.consultants);
    if (!next) {
      await cancelHoursOpenDrain(orgId);
      return;
    }

    const delayMs = next.getTime() - Date.now();
    if (delayMs <= 0) {
      await cancelHoursOpenDrain(orgId);
      return;
    }

    const queued = await enqueueHoursOpenDrain(orgId, delayMs);
    if (queued === "added") {
      debugInfo(
        "[distribution] hours_open scheduled",
        () => JSON.stringify({
          orgId,
          delayMs,
          at: next.toISOString(),
        }),
      );
    }
  } catch (e) {
    console.warn("[distribution] syncHoursOpenDrain failed", e);
  }
}

export async function cancelHoursOpenDrainForOrg(): Promise<void> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return;
  try {
    await cancelHoursOpenDrain(orgId);
  } catch (e) {
    console.warn("[distribution] cancelHoursOpenDrain failed", e);
  }
}

/** PATCH de expediente: recontagem leve + reagenda o delayed. */
export async function syncHoursOpenDrainFromDb(): Promise<void> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return;

  try {
    const pending = await prisma.conversation.count({
      where: await getWaitingQueueWhere(),
    });
    if (pending <= 0) {
      await cancelHoursOpenDrain(orgId);
      return;
    }

    const configs = await prisma.distributionResponsible.findMany({
      where: { participates: true, paused: false },
      select: { userId: true, preLunchStopMinutes: true },
    });
    if (configs.length === 0) {
      await cancelHoursOpenDrain(orgId);
      return;
    }

    const schedules = await prisma.agentSchedule.findMany({
      where: { userId: { in: configs.map((c) => c.userId) } },
      select: {
        userId: true,
        startTime: true,
        lunchStart: true,
        lunchEnd: true,
        endTime: true,
        timezone: true,
        weekdays: true,
        saturdayEnabled: true,
        saturdayStart: true,
        saturdayEnd: true,
      },
    });
    const byUser = new Map(schedules.map((s) => [s.userId, s]));
    const consultants: HoursOpenConsultant[] = [];
    for (const c of configs) {
      const s = byUser.get(c.userId);
      if (!s) continue;
      consultants.push({
        preLunchStopMinutes: c.preLunchStopMinutes,
        schedule: {
          startTime: s.startTime,
          lunchStart: s.lunchStart,
          lunchEnd: s.lunchEnd,
          endTime: s.endTime,
          timezone: s.timezone,
          weekdays: s.weekdays,
          saturdayEnabled: s.saturdayEnabled,
          saturdayStart: s.saturdayStart,
          saturdayEnd: s.saturdayEnd,
        },
      });
    }

    await syncHoursOpenDrain({ pending, consultants });
  } catch (e) {
    console.warn("[distribution] syncHoursOpenDrainFromDb failed", e);
  }
}
