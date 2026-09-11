import { describe, expect, it } from "vitest";

import { resolveZonedDayStart } from "@/lib/zoned-date";

import type { ScheduleLike } from "../eligibility";
import {
  hoursOpenConsultantsFromResponsibles,
  isClockEligibleNow,
  nextHoursOpenAt,
  type HoursOpenConsultant,
} from "../hours-open";

const TZ = "America/Sao_Paulo";

const weekday: ScheduleLike = {
  startTime: "08:00",
  lunchStart: "12:00",
  lunchEnd: "13:00",
  endTime: "18:00",
  timezone: TZ,
  weekdays: [1, 2, 3, 4, 5],
  saturdayEnabled: false,
};

function at(ymd: string, hhmm: string): Date {
  const start = resolveZonedDayStart(ymd, TZ);
  if (!start) throw new Error(`bad day ${ymd}`);
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(start.getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000);
}

const one: HoursOpenConsultant = { schedule: weekday, preLunchStopMinutes: 30 };

describe("nextHoursOpenAt", () => {
  it("returns null when nobody has a schedule / list is empty", () => {
    expect(nextHoursOpenAt([], at("2026-09-14", "07:00"))).toBeNull();
  });

  it("returns null when the consultant is already inside working hours", () => {
    expect(nextHoursOpenAt([one], at("2026-09-14", "10:00"))).toBeNull();
  });

  it("wakes at startTime the same weekday morning", () => {
    const next = nextHoursOpenAt([one], at("2026-09-14", "07:00"));
    expect(next?.toISOString()).toBe(at("2026-09-14", "08:00").toISOString());
  });

  it("wakes at lunchEnd during the lunch / pré-almoço window", () => {
    const next = nextHoursOpenAt([one], at("2026-09-14", "12:15"));
    expect(next?.toISOString()).toBe(at("2026-09-14", "13:00").toISOString());
  });

  it("wakes next weekday start after pré-fim / after hours", () => {
    const next = nextHoursOpenAt([one], at("2026-09-14", "17:50"));
    expect(next?.toISOString()).toBe(at("2026-09-15", "08:00").toISOString());
  });

  it("skips the weekend to Monday start", () => {
    const next = nextHoursOpenAt([one], at("2026-09-11", "18:30"));
    expect(next?.toISOString()).toBe(at("2026-09-14", "08:00").toISOString());
  });

  it("uses saturdayStart when saturday is enabled", () => {
    const sat: HoursOpenConsultant = {
      schedule: {
        ...weekday,
        saturdayEnabled: true,
        saturdayStart: "09:00",
        saturdayEnd: "13:00",
      },
    };
    const next = nextHoursOpenAt([sat], at("2026-09-12", "08:00"));
    expect(next?.toISOString()).toBe(at("2026-09-12", "09:00").toISOString());
  });

  it("picks the earliest consultant still outside hours", () => {
    const late: HoursOpenConsultant = {
      schedule: { ...weekday, startTime: "09:30" },
    };
    const next = nextHoursOpenAt([late, one], at("2026-09-14", "07:00"));
    expect(next?.toISOString()).toBe(at("2026-09-14", "08:00").toISOString());
  });

  it("isClockEligibleNow matches weekday / lunch / saturday", () => {
    expect(isClockEligibleNow(one, at("2026-09-14", "10:00"))).toBe(true);
    expect(isClockEligibleNow(one, at("2026-09-14", "07:00"))).toBe(false);
    expect(isClockEligibleNow(one, at("2026-09-14", "12:10"))).toBe(false);
    expect(isClockEligibleNow(one, at("2026-09-12", "10:00"))).toBe(false);
  });

  it("hoursOpenConsultantsFromResponsibles drops paused / inactive / no schedule", () => {
    const rows = hoursOpenConsultantsFromResponsibles([
      {
        participates: true,
        paused: false,
        schedule: weekday,
        preLunchStopMinutes: 15,
      },
      { participates: false, paused: false, schedule: weekday },
      { participates: true, paused: true, schedule: weekday },
      { participates: true, paused: false, schedule: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.preLunchStopMinutes).toBe(15);
  });
});
