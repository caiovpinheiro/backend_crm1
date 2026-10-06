/**
 * Períodos e relógio do Painel. Métrica de negócio = acumulado do período.
 * Métrica de atendimento "Agora" = estado presente (não passa por aqui).
 */

export const PAINEL_TZ = "America/Sao_Paulo";
export const SNAPSHOT_RETENTION_DAYS = 400;
export const MIN_PREV_RECORDS_FOR_DELTA = 5;
export const DEFAULT_STALLED_DAYS = 7;
export const DEFAULT_NO_REPLY_HOURS = 1;
export const DEFAULT_SLA_MINUTES = 60;

export type PainelPeriodKey =
  | "today"
  | "last_7"
  | "last_30"
  | "this_month"
  | "custom";

export type PainelRange = { from: Date; to: Date };

export type ClockMode = "business" | "elapsed";

export type BusinessHours = {
  startMin: number;
  endMin: number;
  /** JS getDay(): 0=Dom … 6=Sáb. Default Seg–Sex. */
  weekdays: number[];
};

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  startMin: 9 * 60,
  endMin: 18 * 60,
  weekdays: [1, 2, 3, 4, 5],
};

export function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object" && v !== null && "toNumber" in v) {
    const d = v as { toNumber: () => number };
    if (typeof d.toNumber === "function") return d.toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Interpreta YYYY-MM-DD no fuso do Painel (America/Sao_Paulo = UTC-3). */
export function parseDay(value: string | null, end: boolean): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `Intl.DateTimeFormat` custa caro de construir (milhares de microssegundos) e
 * `zonedParts` roda por dia de cada conversa no relógio comercial. Um formatter
 * por fuso, criado uma vez por processo.
 */
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = zonedFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    zonedFormatters.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

/** Partes civis no fuso do Painel. */
export function zonedParts(
  date: Date,
  timeZone = PAINEL_TZ,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = zonedFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayRaw = get("weekday") as keyof typeof WEEKDAY_INDEX;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[weekdayRaw] ?? date.getDay(),
  };
}

export function dayKeyFromDate(date: Date, timeZone = PAINEL_TZ): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Meia-noite local (TZ) expressa em Date UTC. */
export function startOfZonedDay(date: Date, timeZone = PAINEL_TZ): Date {
  const p = zonedParts(date, timeZone);
  return parseDay(
    `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    false,
  )!;
}

/**
 * Períodos inclusivos (hoje conta). last_30 = hoje e os 29 dias anteriores.
 * Default do Painel: hoje.
 */
export function computePainelRange(
  period: string | null,
  startDate: string | null,
  endDate: string | null,
  now = new Date(),
): PainelRange {
  if (period === "custom") {
    const from = parseDay(startDate, false);
    const to = parseDay(endDate, true);
    if (from && to && from <= to) return { from, to };
  }

  const from = startOfZonedDay(now);
  const to = parseDay(dayKeyFromDate(now), true)!;

  switch (period) {
    case "today":
      return { from, to };
    case "last_7": {
      const start = new Date(from);
      start.setDate(start.getDate() - 6);
      return { from: start, to };
    }
    case "this_month": {
      const p = zonedParts(now);
      const monthStart = parseDay(
        `${p.year}-${String(p.month).padStart(2, "0")}-01`,
        false,
      )!;
      return { from: monthStart, to };
    }
    case "yesterday": {
      const y = new Date(from);
      y.setDate(y.getDate() - 1);
      return { from: y, to: parseDay(dayKeyFromDate(y), true)! };
    }
    case "last_month": {
      const p = zonedParts(now);
      const firstThis = parseDay(
        `${p.year}-${String(p.month).padStart(2, "0")}-01`,
        false,
      )!;
      const lastPrev = new Date(firstThis.getTime() - 1);
      const pp = zonedParts(lastPrev);
      const firstPrev = parseDay(
        `${pp.year}-${String(pp.month).padStart(2, "0")}-01`,
        false,
      )!;
      return { from: firstPrev, to: lastPrev };
    }
    case "last_30": {
      const start = new Date(from);
      start.setDate(start.getDate() - 29);
      return { from: start, to };
    }
    default:
      return { from, to };
  }
}

/** Teto de período das consultas pesadas do Painel (90 dias). */
export const PAINEL_MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Mantém o FIM do período e recua o início para no máximo `maxMs` de janela
 * (o dado mais recente é o que o painel mostra). Devolve o próprio objeto
 * quando já cabe.
 */
export function clampRangeFromEnd(range: PainelRange, maxMs: number): PainelRange {
  const span = range.to.getTime() - range.from.getTime();
  if (span <= maxMs) return range;
  return { from: new Date(range.to.getTime() - maxMs), to: range.to };
}

/** Janela imediatamente anterior, mesmo comprimento. */
export function previousPeriod(from: Date, to: Date): PainelRange {
  const span = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - span);
  return { from: prevFrom, to: prevTo };
}

export function eachDayKey(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = startOfZonedDay(from);
  const end = startOfZonedDay(to);
  let guard = 0;
  while (cursor <= end && guard < 800) {
    keys.push(dayKeyFromDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  return keys;
}

export function periodIncludesToday(to: Date, now = new Date()): boolean {
  return dayKeyFromDate(to) >= dayKeyFromDate(now);
}

export function parseClockMode(raw: string | null): ClockMode {
  return raw === "elapsed" ? "elapsed" : "business";
}

export function parseBusinessHours(raw: unknown): BusinessHours {
  if (!raw || typeof raw !== "object") return DEFAULT_BUSINESS_HOURS;
  const o = raw as {
    start?: string;
    end?: string;
    weekdays?: unknown;
  };
  const parseHm = (s: string | undefined, fallback: number) => {
    if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return fallback;
    const [h, m] = s.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) return fallback;
    return h * 60 + m;
  };
  const startMin = parseHm(o.start, DEFAULT_BUSINESS_HOURS.startMin);
  const endMin = parseHm(o.end, DEFAULT_BUSINESS_HOURS.endMin);
  const weekdays = Array.isArray(o.weekdays)
    ? o.weekdays
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : DEFAULT_BUSINESS_HOURS.weekdays;
  if (weekdays.length === 0 || endMin <= startMin) return DEFAULT_BUSINESS_HOURS;
  return { startMin, endMin, weekdays };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** São Paulo é UTC-3 o ano todo (mesma premissa de `parseDay`). */
const PAINEL_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Milissegundos de relógio comercial entre dois instantes.
 * Noites e dias fora de `weekdays` não contam.
 *
 * Só o dia civil de `from` passa pelo formatter. Os dias seguintes andam em
 * aritmética de calendário (UTC), sem criar `Date` nem formatter por dia: o
 * cálculo roda uma vez por conversa encerrada (até 10 mil no ranking de TMA).
 */
export function businessMsBetween(
  from: Date,
  to: Date,
  bh: BusinessHours = DEFAULT_BUSINESS_HOURS,
): number {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (toMs <= fromMs) return 0;
  const first = zonedParts(from);
  // Meia-noite civil de SP, em ms UTC, do dia de `from`.
  let dayStart = Date.UTC(first.year, first.month - 1, first.day) + PAINEL_UTC_OFFSET_MS;
  let weekday = first.weekday;
  let ms = 0;
  for (let guard = 0; guard < 800 && dayStart <= toMs; guard++) {
    if (bh.weekdays.includes(weekday)) {
      const winStart = dayStart + bh.startMin * 60_000;
      const winEnd = dayStart + bh.endMin * 60_000;
      const a = fromMs > winStart ? fromMs : winStart;
      const b = toMs < winEnd ? toMs : winEnd;
      if (b > a) ms += b - a;
    }
    dayStart += DAY_MS;
    weekday = (weekday + 1) % 7;
  }
  return ms;
}

/** Instantâneo "há `durationMs` de horário comercial". */
export function subtractBusinessMs(
  from: Date,
  durationMs: number,
  bh: BusinessHours = DEFAULT_BUSINESS_HOURS,
): Date {
  if (durationMs <= 0) return from;
  let remaining = durationMs;
  const cursor = new Date(from);
  let guard = 0;
  while (remaining > 0 && guard < 800) {
    const parts = zonedParts(cursor);
    const dayKey = dayKeyFromDate(cursor);
    const winStart = parseDay(dayKey, false)!;
    winStart.setMinutes(winStart.getMinutes() + bh.startMin);
    const winEnd = parseDay(dayKey, false)!;
    winEnd.setMinutes(winEnd.getMinutes() + bh.endMin);

    if (bh.weekdays.includes(parts.weekday) && cursor.getTime() > winStart.getTime()) {
      const sliceEnd = cursor.getTime() < winEnd.getTime() ? cursor : winEnd;
      const available = sliceEnd.getTime() - winStart.getTime();
      if (available > 0) {
        if (remaining <= available) {
          return new Date(sliceEnd.getTime() - remaining);
        }
        remaining -= available;
      }
    }
    const prev = startOfZonedDay(cursor);
    cursor.setTime(prev.getTime() - 1);
    guard++;
  }
  return cursor;
}

export function waitMs(
  from: Date,
  to: Date,
  clock: ClockMode,
  bh: BusinessHours = DEFAULT_BUSINESS_HOURS,
): number {
  if (clock === "elapsed") {
    return Math.max(0, to.getTime() - from.getTime());
  }
  return businessMsBetween(from, to, bh);
}

export type PainelDelta = { value: number; hidden: boolean };

export function painelDelta(
  current: number,
  previous: number,
  prevRecords: number,
): PainelDelta {
  if (prevRecords < MIN_PREV_RECORDS_FOR_DELTA) {
    return { value: 0, hidden: true };
  }
  if (!previous) {
    return { value: 0, hidden: true };
  }
  return {
    value: round2(((current - previous) / previous) * 100),
    hidden: false,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function parseStalledDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 365) return DEFAULT_STALLED_DAYS;
  return Math.round(n);
}
