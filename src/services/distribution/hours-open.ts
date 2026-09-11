/**
 * Próximo instante em que o relógio de algum consultor pode voltar a
 * elegível (início do expediente, volta do almoço, sábado).
 *
 * Reusa `evaluateResponsibleEligibility` só na fatia de horário — presença,
 * pausa e teto ficam nos gatilhos de evento. Sem IO.
 */

import { resolveZonedDayStart, formatZonedDay } from "@/lib/zoned-date";

import {
  evaluateResponsibleEligibility,
  type ScheduleLike,
} from "./eligibility";

export type HoursOpenConsultant = {
  schedule: ScheduleLike;
  preLunchStopMinutes?: number;
};

const LOOKAHEAD_DAYS = 8;
const CANDIDATE_FIELDS = ["startTime", "lunchEnd", "saturdayStart"] as const;

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const [h, m] = String(hhmm ?? "00:00").split(":").map(Number);
  return {
    hour: Number.isFinite(h) ? h : 0,
    minute: Number.isFinite(m) ? m : 0,
  };
}

function addUtcDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

function wallClockOnDay(
  timezone: string,
  ymd: string,
  hhmm: string,
): Date | null {
  const start = resolveZonedDayStart(ymd, timezone);
  if (!start) return null;
  const { hour, minute } = parseHhmm(hhmm);
  return new Date(start.getTime() + (hour * 60 + minute) * 60_000);
}

/**
 * True se, ignorando presença/pausa/teto, o expediente deixaria o
 * consultor elegível em `now`.
 */
export function isClockEligibleNow(
  consultant: HoursOpenConsultant,
  now: Date,
): boolean {
  return evaluateResponsibleEligibility(
    {
      participates: true,
      paused: false,
      queueLimit: 1,
      queueCount: 0,
      type: null,
      status: "ONLINE",
      schedule: consultant.schedule,
      preLunchStopMinutes: consultant.preLunchStopMinutes,
    },
    { now },
  ).eligible;
}

function nextHoursOpenForConsultant(
  consultant: HoursOpenConsultant,
  now: Date,
): Date | null {
  const { schedule } = consultant;
  const tz = schedule.timezone || "America/Sao_Paulo";
  const today = formatZonedDay(now, tz);
  let earliest: Date | null = null;

  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset++) {
    const ymd = addUtcDays(today, offset);
    for (const field of CANDIDATE_FIELDS) {
      const hhmm =
        field === "saturdayStart"
          ? (schedule.saturdayStart ?? "09:00")
          : schedule[field];
      const at = wallClockOnDay(tz, ymd, hhmm);
      if (!at || at.getTime() <= now.getTime()) continue;
      if (!isClockEligibleNow(consultant, at)) continue;
      if (!earliest || at.getTime() < earliest.getTime()) earliest = at;
    }
  }

  return earliest;
}

/**
 * Menor instante futuro em que algum consultor **fora do relógio** volta
 * a ficar elegível por expediente. Quem já está dentro do horário não
 * entra (offline/teto acordam por evento). Sem expediente → null.
 */
export function nextHoursOpenAt(
  consultants: HoursOpenConsultant[],
  now = new Date(),
): Date | null {
  let earliest: Date | null = null;
  for (const c of consultants) {
    if (isClockEligibleNow(c, now)) continue;
    const at = nextHoursOpenForConsultant(c, now);
    if (!at) continue;
    if (!earliest || at.getTime() < earliest.getTime()) earliest = at;
  }
  return earliest;
}

export function hoursOpenConsultantsFromResponsibles(
  views: Array<{
    participates: boolean;
    paused: boolean;
    schedule: ScheduleLike | null;
    preLunchStopMinutes?: number;
  }>,
): HoursOpenConsultant[] {
  const out: HoursOpenConsultant[] = [];
  for (const v of views) {
    if (!v.participates || v.paused || !v.schedule) continue;
    out.push({
      schedule: v.schedule,
      preLunchStopMinutes: v.preLunchStopMinutes,
    });
  }
  return out;
}
