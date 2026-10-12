/**
 * Agregações de `activity_events` para `GET /api/activity-feed/stats`.
 *
 * Quem chama (frontend): os cards de evento da aba Negócios do Dashboard
 * (`usePainelEventCards` lê só `totals.byType`) e a aba Estatísticas de Logs
 * (tudo). Antes eram seis consultas sobre a janela inteira — sem período, o
 * default de 30 dias (~665 mil eventos numa org grande, 1,8 s) a cada abertura
 * do Dashboard. Agora:
 *  - a janela vem do pedido (`period` do Painel, ou `from`/`to`);
 *  - UMA varredura (`GROUPING SETS`) monta totais, timeline e horas;
 *  - resultado em cache por org + janela (`cachedReport`, 60 s + 120 s vencido).
 *
 * Índice: `activity_events_org_occurred_at_cursor_idx` (organizationId,
 * occurredAt) + poda de partição por `occurredAt` (tabela particionada por
 * RANGE). A janela de hoje lê só as linhas de hoje da partição corrente.
 */
import { Prisma } from "@prisma/client";

import { analyticsClient } from "@/lib/analytics";
import { localTs } from "@/lib/local-time-sql";
import { REPORT_MAX_RANGE_MS } from "@/lib/report-cache";
import {
  clampRangeFromEnd,
  computePainelRange,
  dayKeyFromSqlDate,
  eachDayKey,
  parseDay,
  type PainelRange,
} from "@/services/painel-period";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sem período no pedido: últimos 30 dias (contrato antigo, a tela de Logs depende). */
export const ACTIVITY_STATS_DEFAULT_MS = 30 * DAY_MS;
const BY_TYPE_LIMIT = 20;

/** Os mesmos de `/api/painel/*` (`computePainelRange`). */
export const ACTIVITY_STATS_PERIODS = [
  "today",
  "yesterday",
  "last_7",
  "last_30",
  "this_month",
  "last_month",
  "custom",
] as const;

const ACTORS = ["HUMAN", "AI", "AUTOMATION", "INTEGRATION", "SYSTEM"] as const;
type ActorKey = (typeof ACTORS)[number];
type ActorCounts = Record<ActorKey, number>;

export type ActivityStatsWindow = PainelRange & { rangeClamped: boolean };

export type ActivityFeedStats = {
  window: { from: string; to: string };
  totals: {
    total: number;
    byActorType: Record<string, number>;
    byEntityType: Record<string, number>;
    byType: { type: string; count: number }[];
  };
  timeline: { day: string; count: number }[];
  timelineByActor: ({ day: string } & ActorCounts)[];
  hourly: { hour: number; count: number }[];
};

/** ISO completo, ou `YYYY-MM-DD` = início/fim do dia civil de São Paulo. */
function parseBound(raw: string | null, end: boolean): Date | null | "invalid" {
  if (raw == null || raw.trim() === "") return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseDay(value, end) ?? "invalid";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

/**
 * Janela pedida. Precedência: `from`/`to` (ou `dateFrom`/`dateTo`) > `period`
 * (+ `startDate`/`endDate` quando `custom`) > últimos 30 dias. Só `from`: até
 * agora. Só `to`: os 30 dias antes dele. Teto de 366 dias (mantém o fim).
 */
export function parseActivityStatsWindow(
  sp: URLSearchParams,
  now: Date = new Date(),
): { ok: true; window: ActivityStatsWindow } | { ok: false; message: string } {
  const fromRaw = sp.get("from") ?? sp.get("dateFrom");
  const toRaw = sp.get("to") ?? sp.get("dateTo");
  const from = parseBound(fromRaw, false);
  const to = parseBound(toRaw, true);
  if (from === "invalid" || to === "invalid") {
    return { ok: false, message: "Data inválida em from/to (ISO 8601 ou AAAA-MM-DD)." };
  }

  let range: PainelRange;
  if (from || to) {
    const end = to ?? now;
    range = { from: from ?? new Date(end.getTime() - ACTIVITY_STATS_DEFAULT_MS), to: end };
  } else {
    const period = sp.get("period");
    if (period) {
      if (!(ACTIVITY_STATS_PERIODS as readonly string[]).includes(period)) {
        return {
          ok: false,
          message: `period inválido. Use: ${ACTIVITY_STATS_PERIODS.join(", ")}.`,
        };
      }
      range = computePainelRange(period, sp.get("startDate"), sp.get("endDate"), now);
    } else {
      range = { from: new Date(now.getTime() - ACTIVITY_STATS_DEFAULT_MS), to: now };
    }
  }

  if (range.from > range.to) {
    return { ok: false, message: "from precisa ser anterior a to." };
  }
  const clamped = clampRangeFromEnd(range, REPORT_MAX_RANGE_MS);
  return {
    ok: true,
    window: { ...clamped, rangeClamped: clamped.from.getTime() !== range.from.getTime() },
  };
}

type Row = {
  kind: "actor" | "entity" | "type" | "day" | "hour";
  day: Date | null;
  actorType: string | null;
  entityType: string | null;
  type: string | null;
  hour: number | null;
  count: bigint;
};

const emptyActors = (): ActorCounts => ({
  HUMAN: 0,
  AI: 0,
  AUTOMATION: 0,
  INTEGRATION: 0,
  SYSTEM: 0,
});

/**
 * Uma varredura da janela. Dia e hora são do relógio de São Paulo (`localTs`),
 * iguais aos do Painel — `timeline[].day` é o dia civil de SP, não o dia UTC.
 */
export async function loadActivityFeedStats(
  orgId: string,
  range: PainelRange,
): Promise<ActivityFeedStats> {
  const rows = await analyticsClient().$queryRaw<Row[]>(Prisma.sql`
    SELECT
      CASE
        WHEN GROUPING(e.day) = 0 THEN 'day'
        WHEN GROUPING(e.hour) = 0 THEN 'hour'
        WHEN GROUPING(e.type) = 0 THEN 'type'
        WHEN GROUPING(e."entityType") = 0 THEN 'entity'
        ELSE 'actor'
      END AS kind,
      e.day,
      e."actorType",
      e."entityType",
      e.type,
      e.hour,
      COUNT(*)::bigint AS count
    FROM (
      SELECT
        ${localTs('"occurredAt"')}::date AS day,
        "actorType"::text AS "actorType",
        "entityType"::text AS "entityType",
        type,
        EXTRACT(HOUR FROM ${localTs('"occurredAt"')})::int AS hour
      FROM activity_events
      WHERE "organizationId" = ${orgId}
        AND "occurredAt" >= ${range.from}
        AND "occurredAt" <= ${range.to}
    ) e
    GROUP BY GROUPING SETS (
      (e."actorType"),
      (e."entityType"),
      (e.type),
      (e.day, e."actorType"),
      (e.hour)
    )
  `);

  const byActorType: Record<string, number> = {};
  const byEntityType: Record<string, number> = {};
  const byType: { type: string; count: number }[] = [];
  const byDay = new Map<string, ActorCounts>();
  const hourlyMap = new Map<number, number>();
  let total = 0;

  for (const r of rows) {
    const n = Number(r.count);
    switch (r.kind) {
      case "actor":
        byActorType[r.actorType ?? "SYSTEM"] = n;
        total += n;
        break;
      case "entity":
        byEntityType[r.entityType ?? ""] = n;
        break;
      case "type":
        byType.push({ type: r.type ?? "", count: n });
        break;
      case "hour":
        hourlyMap.set(Number(r.hour), n);
        break;
      case "day": {
        if (!r.day) break;
        const key = dayKeyFromSqlDate(r.day);
        const bucket = byDay.get(key) ?? emptyActors();
        const actor = (ACTORS as readonly string[]).includes(r.actorType ?? "")
          ? (r.actorType as ActorKey)
          : "SYSTEM";
        bucket[actor] += n;
        byDay.set(key, bucket);
        break;
      }
    }
  }

  byType.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const timelineByActor = eachDayKey(range.from, range.to).map((day) => ({
    day,
    ...(byDay.get(day) ?? emptyActors()),
  }));

  return {
    window: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals: {
      total,
      byActorType,
      byEntityType,
      byType: byType.slice(0, BY_TYPE_LIMIT),
    },
    timeline: timelineByActor.map((r) => ({
      day: r.day,
      count: r.HUMAN + r.AI + r.AUTOMATION + r.INTEGRATION + r.SYSTEM,
    })),
    timelineByActor,
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hourlyMap.get(hour) ?? 0,
    })),
  };
}
