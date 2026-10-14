/**
 * Quem pode receber um repasse da IA no modo por leads.
 * O sorteio (peso) continua no motor de leads. Aqui só entra o recorte
 * deste agente: departamento do destino, papéis, pessoas escolhidas,
 * online e dentro do expediente. Sem isso, o motor não muda.
 */

import { prisma } from "@/lib/prisma";
import { isWithinWorkingHours, type ScheduleLike } from "@/services/distribution/eligibility";

export type LeadsRoutingScope = {
  departmentId: string;
  roleIds: string[];
  userIds: string[];
};

export function readLeadsScope(raw: unknown): LeadsRoutingScope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const departmentId = typeof o.departmentId === "string" ? o.departmentId.trim() : "";
  if (!departmentId) return null;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  return { departmentId, roleIds: list(o.roleIds), userIds: list(o.userIds) };
}

function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function localParts(timezone: string, now: Date): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(now);
  const hourRaw = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = hourRaw === "24" ? 0 : parseInt(hourRaw, 10);
  return { weekday: map[weekdayStr] ?? 0, minutes: hour * 60 + parseInt(minute, 10) };
}

/** Online de propósito e, se houver expediente, dentro dele (sábado incluso). */
export function canReceiveLeadNow(
  status: string | null | undefined,
  schedule: ScheduleLike | null | undefined,
  now: Date = new Date(),
): boolean {
  if (status !== "ONLINE") return false;
  if (!schedule) return true;
  const { weekday, minutes } = localParts(schedule.timezone, now);
  if (weekday === 6) {
    if (!schedule.saturdayEnabled || !schedule.saturdayStart || !schedule.saturdayEnd) return false;
    const start = parseTime(schedule.saturdayStart);
    const end = parseTime(schedule.saturdayEnd);
    return minutes >= start && minutes < end;
  }
  return isWithinWorkingHours(schedule, now);
}

/**
 * Quem pode entrar no sorteio deste repasse: o cargo escolhido (atribuição
 * do papel, na org inteira — não só quem está em department_members), as
 * pessoas marcadas e, no departamento, quem casa com o preset do papel.
 * Online e dentro do expediente. Peso zero ou inativo sai depois, no sorteio.
 */
export async function eligibleUserIdsForScope(scope: LeadsRoutingScope, now: Date = new Date()): Promise<string[]> {
  const members = await prisma.departmentMember.findMany({
    where: { departmentId: scope.departmentId },
    select: { userId: true },
  });
  const memberIds = [...new Set(members.map((m) => m.userId))];
  let ids = memberIds;
  if (scope.roleIds.length > 0) {
    const roles = await prisma.role.findMany({
      where: { id: { in: scope.roleIds } },
      select: { systemPreset: true },
    });
    const presets = roles
      .map((r) => r.systemPreset)
      .filter((p): p is "ADMIN" | "MANAGER" | "MEMBER" => p === "ADMIN" || p === "MANAGER" || p === "MEMBER");
    const assigned = await prisma.userRoleAssignment.findMany({
      where: { roleId: { in: scope.roleIds } },
      select: { userId: true },
    });
    const byRole = new Set(assigned.map((a) => a.userId));
    if (presets.length > 0 && memberIds.length > 0) {
      const byPreset = await prisma.user.findMany({
        where: { id: { in: memberIds }, role: { in: presets } },
        select: { id: true },
      });
      for (const u of byPreset) byRole.add(u.id);
    }
    ids = [...byRole];
  }
  if (scope.userIds.length > 0) {
    const picked = new Set(scope.userIds);
    ids = ids.filter((id) => picked.has(id));
  }
  if (ids.length === 0) return [];

  const [statuses, schedules] = await Promise.all([
    prisma.agentStatus.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, status: true },
    }),
    prisma.agentSchedule.findMany({
      where: { userId: { in: ids } },
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
    }),
  ]);
  const statusOf = new Map(statuses.map((s) => [s.userId, s.status]));
  const scheduleOf = new Map(schedules.map((s) => [s.userId, s]));
  return ids.filter((id) => canReceiveLeadNow(statusOf.get(id), scheduleOf.get(id) ?? null, now));
}
