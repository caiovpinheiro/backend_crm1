/**
 * Período dos contadores do canvas de automação (`?period=` em
 * `/api/automations/:id/stats` e `/logs`).
 *
 * "Hoje"/"Ontem" são dias de Brasília, não UTC: sem isso o que roda depois
 * das 21h cairia no dia seguinte. O Brasil não tem horário de verão desde
 * 2019, então o deslocamento é fixo em UTC-3.
 */
export const STATS_PERIODS = ["today", "yesterday", "7d", "30d"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Valor desconhecido ou ausente = sem filtro (tudo). */
export function parseStatsPeriod(raw: string | null | undefined): StatsPeriod | null {
  const v = raw?.trim().toLowerCase();
  return (STATS_PERIODS as readonly string[]).includes(v ?? "") ? (v as StatsPeriod) : null;
}

/** Intervalo `[gte, lt)` em UTC para usar em `executedAt`. */
export function statsPeriodRange(
  period: StatsPeriod,
  now: Date = new Date(),
): { gte: Date; lt: Date } {
  const local = new Date(now.getTime() - BRT_OFFSET_MS);
  const todayStart =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + BRT_OFFSET_MS;
  const tomorrowStart = todayStart + DAY_MS;
  switch (period) {
    case "today":
      return { gte: new Date(todayStart), lt: new Date(tomorrowStart) };
    case "yesterday":
      return { gte: new Date(todayStart - DAY_MS), lt: new Date(todayStart) };
    case "7d":
      return { gte: new Date(todayStart - 6 * DAY_MS), lt: new Date(tomorrowStart) };
    case "30d":
      return { gte: new Date(todayStart - 29 * DAY_MS), lt: new Date(tomorrowStart) };
  }
}

/** Filtro de `executedAt` pronto para o `where` do Prisma (vazio = tudo). */
export function statsPeriodWhere(
  raw: string | null | undefined,
  now?: Date,
): { executedAt?: { gte: Date; lt: Date } } {
  const period = parseStatsPeriod(raw);
  return period ? { executedAt: statsPeriodRange(period, now) } : {};
}
