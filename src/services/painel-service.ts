/**
 * Aba Atendimentos do Painel (exceto Agora).
 *
 * Volume / tempo / heatmap / canal / motivo respeitam o período.
 * Primeira resposta = até a primeira mensagem humana (não bot).
 * Por atendente: conta para todos que participaram (carga), via atribuição
 * atual + logs de distribuição — não só quem finalizou.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getPainelAgora, type PainelAgora } from "@/services/painel-agora";
import { loadPainelHours } from "@/services/painel-hours";
import {
  DEFAULT_NO_REPLY_HOURS,
  dayKeyFromDate,
  eachDayKey,
  mean,
  median,
  painelDelta,
  parseDay,
  periodIncludesToday,
  previousPeriod,
  round2,
  subtractBusinessMs,
  waitMs,
  type BusinessHours,
  type ClockMode,
  type PainelDelta,
  type PainelRange,
} from "@/services/painel-period";

export type PainelBlock<T> = { ok: true; data: T } | { ok: false; error: string };

export type PainelTimeStat = {
  medianMs: number | null;
  meanMs: number | null;
  sample: number;
};

export type PainelVolume = {
  started: { value: number; delta: PainelDelta };
  finished: { value: number; delta: PainelDelta };
  stillOpen: { value: number; delta: PainelDelta };
  /** Abertas do período que já tiveram resposta humana. */
  openStarted: { value: number; delta: PainelDelta };
  /** Abertas do período ainda aguardando primeira resposta humana. */
  openWaiting: { value: number; delta: PainelDelta };
  messagesIn: number;
  messagesOut: number;
  byDay: { date: string; started: number; finished: number; incomplete: boolean }[];
  empty: boolean;
};

export type PainelDayMs = {
  date: string;
  ms: number | null;
  incomplete: boolean;
};

export type PainelTempo = {
  clock: ClockMode;
  firstResponse: PainelTimeStat;
  subsequent: PainelTimeStat;
  untilClose: PainelTimeStat;
  timeToStart: PainelTimeStat;
  responseByDay: PainelDayMs[];
  startByDay: PainelDayMs[];
  empty: boolean;
};

export type PainelSeriesMeta = { key: string; label: string; color: string };

export type PainelHeatmap = {
  cells: { x: number; y: number; value: number }[];
  series: {
    key: string;
    label: string;
    color: string;
    cells: { x: number; y: number; value: number }[];
  }[];
  xLabels: string[];
  yLabels: string[];
  empty: boolean;
};

export type PainelAttendantRow = {
  id: string;
  name: string;
  attended: number;
  finished: number;
  firstResponseMedianMs: number | null;
  closeMedianMs: number | null;
  stillOpen: number;
  responseMeanMs: number | null;
  startMeanMs: number | null;
  serviceMeanMs: number | null;
};

export type PainelDeptTableRow = {
  key: string;
  label: string;
  started: number;
  finished: number;
  stillOpen: number;
  responseMeanMs: number | null;
  startMeanMs: number | null;
  serviceMeanMs: number | null;
};

export type PainelByDepartment = {
  series: PainelSeriesMeta[];
  points: { date: string; incomplete: boolean; values: Record<string, number> }[];
  summaries: { key: string; label: string; color: string; started: number }[];
  table: PainelDeptTableRow[];
  empty: boolean;
  useBars: boolean;
};

export type PainelConnectionBlock = {
  series: PainelSeriesMeta[];
  points: { date: string; incomplete: boolean; values: Record<string, number> }[];
  empty: boolean;
};

export type PainelConnections = {
  connections: PainelConnectionBlock;
  platforms: PainelConnectionBlock;
};

export type PainelChannelRow = {
  key: string;
  label: string;
  count: number;
  firstResponseMedianMs: number | null;
};

export type PainelMotivoRow = {
  key: string;
  label: string;
  count: number;
  firstResponseMedianMs: number | null;
};

export type PainelServiceException = {
  key: "no_reply" | "open_24h" | "unassigned" | "send_failure";
  count: number;
  href: string;
};

/** Domingo primeiro — igual ao heatmap de referência. */
const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const NONE_DEPT_KEY = "__none__";
const NONE_DEPT_LABEL = "Sem departamento";
const SERIES_COLORS = [
  "var(--color-primary)",
  "var(--color-success)",
  "var(--color-destructive)",
  "var(--color-primary-dark)",
  "var(--color-warning)",
  "var(--color-lead)",
];
const PLATFORM_COLORS: Record<string, string> = {
  WHATSAPP: "var(--color-success)",
  INSTAGRAM: "var(--color-lead)",
  FACEBOOK: "var(--color-primary)",
  EMAIL: "var(--color-warning)",
  WEBCHAT: "var(--color-primary-dark)",
};
const MAX_CONNECTION_SERIES = 6;

function openWhere(): Prisma.ConversationWhereInput {
  return { status: { not: "RESOLVED" }, closedAt: null };
}

function colorAt(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length]!;
}

function platformLabel(raw: string): string {
  switch (raw.toUpperCase()) {
    case "WHATSAPP":
      return "WhatsApp";
    case "INSTAGRAM":
      return "Instagram";
    case "FACEBOOK":
      return "Facebook";
    case "EMAIL":
      return "E-mail";
    case "WEBCHAT":
      return "Webchat";
    default:
      return raw || "Outros";
  }
}

function weekdayOccurrences(days: string[]): number[] {
  const occ = [0, 0, 0, 0, 0, 0, 0];
  for (const key of days) {
    const [y, m, d] = key.split("-").map(Number);
    occ[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] += 1;
  }
  return occ;
}

function roundAvg(count: number, denom: number): number {
  if (denom <= 0 || count <= 0) return 0;
  return Math.round((count / denom) * 10) / 10;
}

function fillDailyPoints(
  days: string[],
  incompleteLast: boolean,
  todayKey: string,
  seriesKeys: string[],
  lookup: Map<string, number>,
): { date: string; incomplete: boolean; values: Record<string, number> }[] {
  return days.map((date) => {
    const values: Record<string, number> = {};
    for (const key of seriesKeys) {
      values[key] = lookup.get(`${date}::${key}`) ?? 0;
    }
    return {
      date,
      incomplete: incompleteLast && date === todayKey,
      values,
    };
  });
}

function wrap<T>(fn: () => Promise<T>): Promise<PainelBlock<T>> {
  return fn()
    .then((data) => ({ ok: true as const, data }))
    .catch((e) => {
      console.error("[painel/service]", e);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Falha ao carregar este bloco.",
      };
    });
}

type ReplyPair = {
  conversationId: string;
  inAt: Date;
  outAt: Date;
  isFirst: boolean;
  departmentId: string | null;
  assignedToId: string | null;
};

type StartRow = {
  conversationId: string;
  createdAt: Date;
  firstHumanAt: Date;
  departmentId: string | null;
  assignedToId: string | null;
};

type ClosedRow = {
  id: string;
  createdAt: Date;
  closedAt: Date | null;
  updatedAt: Date;
  assignedToId: string | null;
  departmentId: string | null;
};

type SharedServiceMetrics = {
  pairs: ReplyPair[];
  startRows: StartRow[];
  closed: ClosedRow[];
  hours: BusinessHours;
};

/**
 * Uma varredura por conversa do período — sem LATERAL por inbound e sem
 * NOT EXISTS correlacionado (era o custo de ~3 min quando rodava 5x).
 */
async function firstHumanReplyPairs(
  orgId: string,
  from: Date,
  to: Date,
): Promise<ReplyPair[]> {
  const rows = await prisma.$queryRaw<
    {
      conversationId: string;
      inAt: Date;
      outAt: Date;
      is_first: number;
      departmentId: string | null;
      assignedToId: string | null;
    }[]
  >(Prisma.sql`
    WITH inbound AS (
      SELECT
        m."conversationId" AS "conversationId",
        m."createdAt" AS "inAt",
        conv."departmentId" AS "departmentId",
        conv."assignedToId" AS "assignedToId"
      FROM messages m
      INNER JOIN conversations conv ON conv.id = m."conversationId"
      WHERE m.direction = 'in'
        AND m."isPrivate" = false
        AND m."organizationId" = ${orgId}
        AND m."createdAt" >= ${from}
        AND m."createdAt" <= ${to}
    ),
    first_ever AS (
      SELECT DISTINCT ON (m."conversationId")
        m."conversationId" AS "conversationId",
        m."createdAt" AS first_in_at
      FROM messages m
      INNER JOIN inbound i ON i."conversationId" = m."conversationId"
      WHERE m.direction = 'in'
        AND m."isPrivate" = false
        AND m."organizationId" = ${orgId}
      ORDER BY m."conversationId", m."createdAt" ASC
    ),
    outs AS (
      SELECT m."conversationId" AS "conversationId", m."createdAt" AS "outAt"
      FROM messages m
      WHERE m.direction = 'out'
        AND m."authorType" = 'human'::"MessageAuthorType"
        AND m."isPrivate" = false
        AND m."organizationId" = ${orgId}
        AND m."createdAt" >= ${from}
        AND EXISTS (
          SELECT 1 FROM inbound i WHERE i."conversationId" = m."conversationId"
        )
    ),
    events AS (
      SELECT
        i."conversationId",
        i."inAt" AS ts,
        0 AS kind_ord,
        i."inAt",
        NULL::timestamptz AS "outAt",
        i."departmentId",
        i."assignedToId"
      FROM inbound i
      UNION ALL
      SELECT
        o."conversationId",
        o."outAt",
        1,
        NULL::timestamptz,
        o."outAt",
        NULL,
        NULL
      FROM outs o
    ),
    filled AS (
      SELECT
        e.*,
        MIN(e."outAt") OVER (
          PARTITION BY e."conversationId"
          ORDER BY e.ts, e.kind_ord
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS next_out
      FROM events e
    )
    SELECT
      f."conversationId",
      f."inAt",
      f.next_out AS "outAt",
      CASE WHEN fe.first_in_at = f."inAt" THEN 1 ELSE 0 END AS is_first,
      f."departmentId",
      f."assignedToId"
    FROM filled f
    LEFT JOIN first_ever fe ON fe."conversationId" = f."conversationId"
    WHERE f.kind_ord = 0
      AND f.next_out IS NOT NULL
  `);
  return rows.map((r) => ({
    conversationId: r.conversationId,
    inAt: r.inAt,
    outAt: r.outAt,
    isFirst: Number(r.is_first) === 1,
    departmentId: r.departmentId,
    assignedToId: r.assignedToId,
  }));
}

async function loadStartRows(
  orgId: string,
  from: Date,
  to: Date,
): Promise<StartRow[]> {
  return prisma.$queryRaw<StartRow[]>(Prisma.sql`
    SELECT
      conv.id AS "conversationId",
      conv."createdAt" AS "createdAt",
      MIN(m."createdAt") AS "firstHumanAt",
      conv."departmentId" AS "departmentId",
      conv."assignedToId" AS "assignedToId"
    FROM conversations conv
    INNER JOIN messages m
      ON m."conversationId" = conv.id
      AND m.direction = 'out'
      AND m."authorType" = 'human'::"MessageAuthorType"
      AND m."isPrivate" = false
      AND m."organizationId" = ${orgId}
    WHERE conv."organizationId" = ${orgId}
      AND conv."createdAt" >= ${from}
      AND conv."createdAt" <= ${to}
    GROUP BY conv.id, conv."createdAt", conv."departmentId", conv."assignedToId"
  `);
}

async function loadClosedRows(range: PainelRange): Promise<ClosedRow[]> {
  return prisma.conversation.findMany({
    where: {
      status: "RESOLVED",
      OR: [
        { closedAt: { gte: range.from, lte: range.to } },
        { closedAt: null, updatedAt: { gte: range.from, lte: range.to } },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      closedAt: true,
      updatedAt: true,
      assignedToId: true,
      departmentId: true,
    },
  });
}

async function loadSharedServiceMetrics(
  range: PainelRange,
): Promise<SharedServiceMetrics> {
  const orgId = getOrgIdOrThrow();
  const [pairs, startRows, closed, hours] = await Promise.all([
    firstHumanReplyPairs(orgId, range.from, range.to),
    loadStartRows(orgId, range.from, range.to),
    loadClosedRows(range),
    loadPainelHours(),
  ]);
  return { pairs, startRows, closed, hours };
}

function statsFromMs(values: number[]): PainelTimeStat {
  return {
    medianMs: median(values),
    meanMs: mean(values),
    sample: values.length,
  };
}

export async function getPainelVolume(
  range: PainelRange,
  clock: ClockMode,
): Promise<PainelVolume> {
  const orgId = getOrgIdOrThrow();
  const prev = previousPeriod(range.from, range.to);
  const incompleteLast = periodIncludesToday(range.to);
  const days = eachDayKey(range.from, range.to);

  const [
    started,
    finished,
    stillOpen,
    openStarted,
    openWaiting,
    prevStarted,
    prevFinished,
    prevStillOpen,
    prevOpenStarted,
    prevOpenWaiting,
    messagesIn,
    messagesOut,
    startedByDay,
    finishedByDay,
  ] = await Promise.all([
    prisma.conversation.count({
      where: { createdAt: { gte: range.from, lte: range.to } },
    }),
    prisma.conversation.count({
      where: {
        status: "RESOLVED",
        OR: [
          { closedAt: { gte: range.from, lte: range.to } },
          { closedAt: null, updatedAt: { gte: range.from, lte: range.to } },
        ],
      },
    }),
    prisma.conversation.count({
      where: {
        createdAt: { gte: range.from, lte: range.to },
        ...openWhere(),
      },
    }),
    prisma.conversation.count({
      where: {
        createdAt: { gte: range.from, lte: range.to },
        ...openWhere(),
        hasHumanReply: true,
      },
    }),
    prisma.conversation.count({
      where: {
        createdAt: { gte: range.from, lte: range.to },
        ...openWhere(),
        hasHumanReply: false,
      },
    }),
    prisma.conversation.count({
      where: { createdAt: { gte: prev.from, lte: prev.to } },
    }),
    prisma.conversation.count({
      where: {
        status: "RESOLVED",
        OR: [
          { closedAt: { gte: prev.from, lte: prev.to } },
          { closedAt: null, updatedAt: { gte: prev.from, lte: prev.to } },
        ],
      },
    }),
    prisma.conversation.count({
      where: {
        createdAt: { gte: prev.from, lte: prev.to },
        ...openWhere(),
      },
    }),
    prisma.conversation.count({
      where: {
        createdAt: { gte: prev.from, lte: prev.to },
        ...openWhere(),
        hasHumanReply: true,
      },
    }),
    prisma.conversation.count({
      where: {
        createdAt: { gte: prev.from, lte: prev.to },
        ...openWhere(),
        hasHumanReply: false,
      },
    }),
    prisma.message.count({
      where: {
        direction: "in",
        isPrivate: false,
        createdAt: { gte: range.from, lte: range.to },
      },
    }),
    prisma.message.count({
      where: {
        direction: "out",
        isPrivate: false,
        createdAt: { gte: range.from, lte: range.to },
      },
    }),
    prisma.$queryRaw<{ d: Date; c: bigint }[]>(Prisma.sql`
      SELECT (conv."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date AS d,
             COUNT(*)::bigint AS c
      FROM conversations conv
      WHERE conv."organizationId" = ${orgId}
        AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
      GROUP BY 1
    `),
    prisma.$queryRaw<{ d: Date; c: bigint }[]>(Prisma.sql`
      SELECT (COALESCE(conv."closedAt", conv."updatedAt") AT TIME ZONE 'America/Sao_Paulo')::date AS d,
             COUNT(*)::bigint AS c
      FROM conversations conv
      WHERE conv."organizationId" = ${orgId}
        AND conv.status = 'RESOLVED'::"ConversationStatus"
        AND COALESCE(conv."closedAt", conv."updatedAt") >= ${range.from}
        AND COALESCE(conv."closedAt", conv."updatedAt") <= ${range.to}
      GROUP BY 1
    `),
  ]);

  void clock;
  const startMap = new Map(startedByDay.map((r) => [dayKeyFromDate(r.d), Number(r.c)]));
  const finMap = new Map(finishedByDay.map((r) => [dayKeyFromDate(r.d), Number(r.c)]));
  const todayKey = dayKeyFromDate(new Date());
  const byDay = days.map((date) => ({
    date,
    started: startMap.get(date) ?? 0,
    finished: finMap.get(date) ?? 0,
    incomplete: incompleteLast && date === todayKey,
  }));

  return {
    started: {
      value: started,
      delta: painelDelta(started, prevStarted, prevStarted),
    },
    finished: {
      value: finished,
      delta: painelDelta(finished, prevFinished, prevFinished),
    },
    stillOpen: {
      value: stillOpen,
      delta: painelDelta(stillOpen, prevStillOpen, prevStillOpen),
    },
    openStarted: {
      value: openStarted,
      delta: painelDelta(openStarted, prevOpenStarted, prevOpenStarted),
    },
    openWaiting: {
      value: openWaiting,
      delta: painelDelta(openWaiting, prevOpenWaiting, prevOpenWaiting),
    },
    messagesIn,
    messagesOut,
    byDay,
    empty: started === 0 && finished === 0 && messagesIn === 0 && messagesOut === 0,
  };
}

export async function getPainelTempo(
  range: PainelRange,
  clock: ClockMode,
  shared: SharedServiceMetrics,
): Promise<PainelTempo> {
  const { pairs, startRows, closed, hours: bh } = shared;
  const incompleteLast = periodIncludesToday(range.to);
  const days = eachDayKey(range.from, range.to);
  const todayKey = dayKeyFromDate(new Date());

  const firstMs: number[] = [];
  const subMs: number[] = [];
  const firstByDay = new Map<string, number[]>();
  for (const p of pairs) {
    const ms = waitMs(p.inAt, p.outAt, clock, bh);
    if (p.isFirst) {
      firstMs.push(ms);
      const key = dayKeyFromDate(p.outAt);
      const bucket = firstByDay.get(key) ?? [];
      bucket.push(ms);
      firstByDay.set(key, bucket);
    } else {
      subMs.push(ms);
    }
  }

  const startMs: number[] = [];
  const startByDayMap = new Map<string, number[]>();
  for (const row of startRows) {
    const ms = waitMs(row.createdAt, row.firstHumanAt, clock, bh);
    startMs.push(ms);
    const key = dayKeyFromDate(row.createdAt);
    const bucket = startByDayMap.get(key) ?? [];
    bucket.push(ms);
    startByDayMap.set(key, bucket);
  }

  const closeMs = closed.map((c) =>
    waitMs(c.createdAt, c.closedAt ?? c.updatedAt, clock, bh),
  );

  const firstResponse = statsFromMs(firstMs);
  const subsequent = statsFromMs(subMs);
  const untilClose = statsFromMs(closeMs);
  const timeToStart = statsFromMs(startMs);

  const toDaySeries = (map: Map<string, number[]>): PainelDayMs[] =>
    days.map((date) => ({
      date,
      ms: mean(map.get(date) ?? []),
      incomplete: incompleteLast && date === todayKey,
    }));

  return {
    clock,
    firstResponse,
    subsequent,
    untilClose,
    timeToStart,
    responseByDay: toDaySeries(firstByDay),
    startByDay: toDaySeries(startByDayMap),
    empty:
      firstResponse.sample === 0 &&
      subsequent.sample === 0 &&
      untilClose.sample === 0 &&
      timeToStart.sample === 0,
  };
}

export async function getPainelHeatmap(range: PainelRange): Promise<PainelHeatmap> {
  const orgId = getOrgIdOrThrow();
  const days = eachDayKey(range.from, range.to);
  const occ = weekdayOccurrences(days);
  const rows = await prisma.$queryRaw<
    { dow: number; h: number; c: bigint; deptId: string | null; deptName: string | null }[]
  >(Prisma.sql`
    SELECT EXTRACT(DOW FROM conv."createdAt" AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
           EXTRACT(HOUR FROM conv."createdAt" AT TIME ZONE 'America/Sao_Paulo')::int AS h,
           conv."departmentId" AS "deptId",
           d.name AS "deptName",
           COUNT(*)::bigint AS c
    FROM conversations conv
    LEFT JOIN departments d ON d.id = conv."departmentId"
    WHERE conv."organizationId" = ${orgId}
      AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
    GROUP BY 1, 2, 3, 4
  `);

  const totalMap = new Map<string, number>();
  const deptMeta = new Map<string, { label: string; count: number }>();
  const seriesMap = new Map<string, Map<string, number>>();

  for (const r of rows) {
    const dow = Number(r.dow);
    const h = Number(r.h);
    const count = Number(r.c);
    const cellKey = `${h}-${dow}`;
    totalMap.set(cellKey, (totalMap.get(cellKey) ?? 0) + count);
    const deptKey = r.deptId || NONE_DEPT_KEY;
    const meta = deptMeta.get(deptKey) ?? {
      label: r.deptName || NONE_DEPT_LABEL,
      count: 0,
    };
    meta.count += count;
    deptMeta.set(deptKey, meta);
    const sm = seriesMap.get(deptKey) ?? new Map<string, number>();
    sm.set(cellKey, (sm.get(cellKey) ?? 0) + count);
    seriesMap.set(deptKey, sm);
  }

  const toCells = (map: Map<string, number>) => {
    const cells: { x: number; y: number; value: number }[] = [];
    for (const [key, count] of map) {
      const [x, y] = key.split("-").map(Number);
      const value = roundAvg(count, occ[y] ?? 1);
      if (value > 0) cells.push({ x, y, value });
    }
    return cells;
  };

  const ranked = [...deptMeta.entries()].sort((a, b) => {
    if (a[0] === NONE_DEPT_KEY) return 1;
    if (b[0] === NONE_DEPT_KEY) return -1;
    return b[1].count - a[1].count || a[1].label.localeCompare(b[1].label, "pt-BR");
  });

  const series = ranked.map(([key, meta], i) => ({
    key,
    label: meta.label,
    color: key === NONE_DEPT_KEY ? "var(--color-primary-dark)" : colorAt(i),
    cells: toCells(seriesMap.get(key) ?? new Map()),
  }));

  const cells = toCells(totalMap);
  return {
    cells,
    series,
    xLabels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")),
    yLabels: WEEKDAY_LABELS,
    empty: cells.length === 0,
  };
}

export async function getPainelAttendants(
  range: PainelRange,
  clock: ClockMode,
  shared: SharedServiceMetrics,
): Promise<{ rows: PainelAttendantRow[]; attribution: string }> {
  const orgId = getOrgIdOrThrow();
  const { pairs, startRows, closed, hours: bh } = shared;
  const attribution =
    "Conta para os dois: cada conversa entra na carga de todo atendente que a recebeu (atribuição atual + distribuição). Não é só quem finalizou.";

  const [loadRows, stillOpenRows, finishedRows] = await Promise.all([
    prisma.$queryRaw<{ userId: string; conversationId: string }[]>(Prisma.sql`
    SELECT DISTINCT x."userId", x."conversationId" FROM (
      SELECT conv."assignedToId" AS "userId", conv.id AS "conversationId"
      FROM conversations conv
      INNER JOIN users u ON u.id = conv."assignedToId"
      WHERE conv."organizationId" = ${orgId}
        AND conv."assignedToId" IS NOT NULL
        AND u.type = 'HUMAN'::"UserType"
        AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
      UNION
      SELECT l."selectedUserId", l."conversationId"
      FROM distribution_logs l
      INNER JOIN users u ON u.id = l."selectedUserId"
      WHERE l."organizationId" = ${orgId}
        AND l.success = true
        AND l."selectedUserId" IS NOT NULL
        AND l."conversationId" IS NOT NULL
        AND u.type = 'HUMAN'::"UserType"
        AND l."createdAt" >= ${range.from} AND l."createdAt" <= ${range.to}
    ) x
  `),
    prisma.conversation.groupBy({
      by: ["assignedToId"],
      where: {
        ...openWhere(),
        assignedToId: { not: null },
        assignedTo: { is: { type: "HUMAN" } },
      },
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ["assignedToId"],
      where: {
        status: "RESOLVED",
        assignedToId: { not: null },
        assignedTo: { is: { type: "HUMAN" } },
        OR: [
          { closedAt: { gte: range.from, lte: range.to } },
          { closedAt: null, updatedAt: { gte: range.from, lte: range.to } },
        ],
      },
      _count: { _all: true },
    }),
  ]);

  const stillOpenMap = new Map(
    stillOpenRows
      .filter((r) => r.assignedToId)
      .map((r) => [r.assignedToId as string, r._count._all]),
  );
  const finishedMap = new Map(
    finishedRows
      .filter((r) => r.assignedToId)
      .map((r) => [r.assignedToId as string, r._count._all]),
  );

  const firstByConv = new Map<string, number>();
  for (const p of pairs) {
    if (!p.isFirst || firstByConv.has(p.conversationId)) continue;
    firstByConv.set(p.conversationId, waitMs(p.inAt, p.outAt, clock, bh));
  }

  const startByConv = new Map(
    startRows.map((r) => [r.conversationId, waitMs(r.createdAt, r.firstHumanAt, clock, bh)]),
  );
  const closeByConv = new Map(
    closed.map((c) => [c.id, waitMs(c.createdAt, c.closedAt ?? c.updatedAt, clock, bh)]),
  );

  const attended = new Map<string, Set<string>>();
  for (const row of loadRows) {
    const set = attended.get(row.userId) ?? new Set();
    set.add(row.conversationId);
    attended.set(row.userId, set);
  }

  const userIds = new Set([
    ...attended.keys(),
    ...stillOpenMap.keys(),
    ...finishedMap.keys(),
  ]);
  const users = userIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...userIds] } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  const rows: PainelAttendantRow[] = [...userIds].map((id) => {
    const convs = attended.get(id) ?? new Set();
    const firstVals: number[] = [];
    const startVals: number[] = [];
    const closeVals: number[] = [];
    for (const cid of convs) {
      const fr = firstByConv.get(cid);
      if (fr != null) firstVals.push(fr);
      const st = startByConv.get(cid);
      if (st != null) startVals.push(st);
      const cl = closeByConv.get(cid);
      if (cl != null) closeVals.push(cl);
    }
    return {
      id,
      name: nameById.get(id) ?? "Sem nome",
      attended: convs.size,
      finished: finishedMap.get(id) ?? 0,
      firstResponseMedianMs: median(firstVals),
      closeMedianMs: median(closeVals),
      stillOpen: stillOpenMap.get(id) ?? 0,
      responseMeanMs: mean(firstVals),
      startMeanMs: mean(startVals),
      serviceMeanMs: mean(closeVals),
    };
  });

  rows.sort(
    (a, b) =>
      b.attended - a.attended ||
      b.stillOpen - a.stillOpen ||
      a.name.localeCompare(b.name, "pt-BR"),
  );

  return { rows, attribution };
}

async function firstResponseByKey(
  pairs: ReplyPair[],
  range: PainelRange,
  clock: ClockMode,
  hours: BusinessHours,
  group: "channel" | "tabulation",
): Promise<Map<string, { count: number; firstMs: number[] }>> {
  const firstByConv = new Map<string, number>();
  for (const p of pairs) {
    if (!p.isFirst) continue;
    firstByConv.set(p.conversationId, waitMs(p.inAt, p.outAt, clock, hours));
  }

  if (group === "channel") {
    const convs = await prisma.conversation.findMany({
      where: { createdAt: { gte: range.from, lte: range.to } },
      select: { id: true, channel: true },
    });
    const map = new Map<string, { count: number; firstMs: number[] }>();
    for (const c of convs) {
      const key = c.channel || "outros";
      const b = map.get(key) ?? { count: 0, firstMs: [] };
      b.count += 1;
      const fr = firstByConv.get(c.id);
      if (fr != null) b.firstMs.push(fr);
      map.set(key, b);
    }
    return map;
  }

  const convs = await prisma.conversation.findMany({
    where: {
      createdAt: { gte: range.from, lte: range.to },
      tabulationId: { not: null },
    },
    select: { id: true, tabulation: { select: { id: true, name: true } } },
  });
  const map = new Map<string, { count: number; firstMs: number[] }>();
  for (const c of convs) {
    if (!c.tabulation) continue;
    const key = c.tabulation.id;
    const b = map.get(key) ?? { count: 0, firstMs: [] };
    b.count += 1;
    const fr = firstByConv.get(c.id);
    if (fr != null) b.firstMs.push(fr);
    map.set(key, b);
  }
  return map;
}

export async function getPainelChannels(
  range: PainelRange,
  clock: ClockMode,
  shared: SharedServiceMetrics,
): Promise<{ channels: PainelChannelRow[]; motivos: PainelMotivoRow[] }> {
  const [byChannel, byMotivo] = await Promise.all([
    firstResponseByKey(shared.pairs, range, clock, shared.hours, "channel"),
    firstResponseByKey(shared.pairs, range, clock, shared.hours, "tabulation"),
  ]);

  const channels: PainelChannelRow[] = [...byChannel.entries()]
    .map(([key, b]) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      count: b.count,
      firstResponseMedianMs: median(b.firstMs),
    }))
    .sort((a, b) => b.count - a.count);

  const motivos: PainelMotivoRow[] = [...byMotivo.entries()]
    .map(([key, b]) => ({
      key,
      label: key,
      count: b.count,
      firstResponseMedianMs: median(b.firstMs),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // Relabel motivos from the extra field we stored.
  const labeled = await prisma.tabulation.findMany({
    where: { id: { in: motivos.map((m) => m.key) } },
    select: { id: true, name: true },
  });
  const names = new Map(labeled.map((t) => [t.id, t.name]));
  for (const row of motivos) {
    row.label = names.get(row.key) ?? row.label;
  }

  return { channels, motivos };
}

export async function getPainelByDepartment(
  range: PainelRange,
  clock: ClockMode,
  shared: SharedServiceMetrics,
): Promise<PainelByDepartment> {
  const orgId = getOrgIdOrThrow();
  const { pairs, startRows, closed, hours: bh } = shared;
  const incompleteLast = periodIncludesToday(range.to);
  const days = eachDayKey(range.from, range.to);
  const todayKey = dayKeyFromDate(new Date());

  const [daily, counts] = await Promise.all([
    prisma.$queryRaw<{ d: Date; deptId: string | null; deptName: string | null; c: bigint }[]>(
      Prisma.sql`
        SELECT (conv."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date AS d,
               conv."departmentId" AS "deptId",
               d.name AS "deptName",
               COUNT(*)::bigint AS c
        FROM conversations conv
        LEFT JOIN departments d ON d.id = conv."departmentId"
        WHERE conv."organizationId" = ${orgId}
          AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
        GROUP BY 1, 2, 3
      `,
    ),
    prisma.$queryRaw<
      {
        deptId: string | null;
        deptName: string | null;
        started: bigint;
        finished: bigint;
        stillOpen: bigint;
      }[]
    >(Prisma.sql`
      SELECT conv."departmentId" AS "deptId",
             d.name AS "deptName",
             COUNT(*)::bigint AS started,
             COUNT(*) FILTER (WHERE conv.status = 'RESOLVED'::"ConversationStatus")::bigint AS finished,
             COUNT(*) FILTER (
               WHERE conv.status <> 'RESOLVED'::"ConversationStatus" AND conv."closedAt" IS NULL
             )::bigint AS "stillOpen"
      FROM conversations conv
      LEFT JOIN departments d ON d.id = conv."departmentId"
      WHERE conv."organizationId" = ${orgId}
        AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
      GROUP BY 1, 2
    `),
  ]);

  const totals = new Map<string, { label: string; started: number }>();
  const lookup = new Map<string, number>();
  for (const r of daily) {
    const key = r.deptId || NONE_DEPT_KEY;
    const label = r.deptName || NONE_DEPT_LABEL;
    const n = Number(r.c);
    const meta = totals.get(key) ?? { label, started: 0 };
    meta.started += n;
    totals.set(key, meta);
    lookup.set(`${dayKeyFromDate(r.d)}::${key}`, n);
  }
  for (const r of counts) {
    const key = r.deptId || NONE_DEPT_KEY;
    if (!totals.has(key)) {
      totals.set(key, { label: r.deptName || NONE_DEPT_LABEL, started: Number(r.started) });
    }
  }

  const ranked = [...totals.entries()].sort((a, b) => {
    if (a[0] === NONE_DEPT_KEY) return 1;
    if (b[0] === NONE_DEPT_KEY) return -1;
    return b[1].started - a[1].started || a[1].label.localeCompare(b[1].label, "pt-BR");
  });
  const series: PainelSeriesMeta[] = ranked.map(([key, meta], i) => ({
    key,
    label: meta.label,
    color: key === NONE_DEPT_KEY ? "var(--color-primary-dark)" : colorAt(i),
  }));

  const responseByDept = new Map<string, number[]>();
  for (const p of pairs) {
    if (!p.isFirst) continue;
    const key = p.departmentId || NONE_DEPT_KEY;
    const bucket = responseByDept.get(key) ?? [];
    bucket.push(waitMs(p.inAt, p.outAt, clock, bh));
    responseByDept.set(key, bucket);
  }
  const startByDept = new Map<string, number[]>();
  for (const row of startRows) {
    const key = row.departmentId || NONE_DEPT_KEY;
    const bucket = startByDept.get(key) ?? [];
    bucket.push(waitMs(row.createdAt, row.firstHumanAt, clock, bh));
    startByDept.set(key, bucket);
  }
  const serviceByDept = new Map<string, number[]>();
  for (const c of closed) {
    const key = c.departmentId || NONE_DEPT_KEY;
    const bucket = serviceByDept.get(key) ?? [];
    bucket.push(waitMs(c.createdAt, c.closedAt ?? c.updatedAt, clock, bh));
    serviceByDept.set(key, bucket);
  }

  const countByKey = new Map(
    counts.map((r) => [
      r.deptId || NONE_DEPT_KEY,
      { finished: Number(r.finished), stillOpen: Number(r.stillOpen), started: Number(r.started) },
    ]),
  );

  const table: PainelDeptTableRow[] = ranked.map(([key, meta]) => {
    const c = countByKey.get(key);
    return {
      key,
      label: meta.label,
      started: c?.started ?? meta.started,
      finished: c?.finished ?? 0,
      stillOpen: c?.stillOpen ?? 0,
      responseMeanMs: mean(responseByDept.get(key) ?? []),
      startMeanMs: mean(startByDept.get(key) ?? []),
      serviceMeanMs: mean(serviceByDept.get(key) ?? []),
    };
  });

  const points = fillDailyPoints(
    days,
    incompleteLast,
    todayKey,
    series.map((s) => s.key),
    lookup,
  );
  const empty = ranked.every(([, m]) => m.started === 0);

  return {
    series,
    points,
    summaries: ranked.map(([key, meta], i) => ({
      key,
      label: meta.label,
      color: series[i]?.color ?? colorAt(i),
      started: meta.started,
    })),
    table,
    empty,
    useBars: days.length <= 7,
  };
}

export async function getPainelConnections(range: PainelRange): Promise<PainelConnections> {
  const orgId = getOrgIdOrThrow();
  const incompleteLast = periodIncludesToday(range.to);
  const days = eachDayKey(range.from, range.to);
  const todayKey = dayKeyFromDate(new Date());

  const rows = await prisma.$queryRaw<
    {
      d: Date;
      chId: string | null;
      chName: string | null;
      phone: string | null;
      platform: string | null;
      c: bigint;
    }[]
  >(Prisma.sql`
    SELECT (conv."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date AS d,
           conv."channelId" AS "chId",
           ch.name AS "chName",
           ch."phoneNumber" AS phone,
           COALESCE(ch.type::text, UPPER(conv.channel), 'OUTROS') AS platform,
           COUNT(*)::bigint AS c
    FROM conversations conv
    LEFT JOIN channels ch ON ch.id = conv."channelId"
    WHERE conv."organizationId" = ${orgId}
      AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
    GROUP BY 1, 2, 3, 4, 5
  `);

  const connTotals = new Map<string, { label: string; count: number }>();
  const connLookup = new Map<string, number>();
  const platTotals = new Map<string, { label: string; count: number }>();
  const platLookup = new Map<string, number>();

  for (const r of rows) {
    const n = Number(r.c);
    const date = dayKeyFromDate(r.d);
    const connKey = r.chId || r.chName || r.platform || "outros";
    const connLabel =
      [r.chName, r.phone].filter(Boolean).join(" · ") || platformLabel(r.platform ?? "Outros");
    const ct = connTotals.get(connKey) ?? { label: connLabel, count: 0 };
    ct.count += n;
    connTotals.set(connKey, ct);
    connLookup.set(`${date}::${connKey}`, (connLookup.get(`${date}::${connKey}`) ?? 0) + n);

    const platKey = (r.platform || "OUTROS").toUpperCase();
    const pt = platTotals.get(platKey) ?? { label: platformLabel(platKey), count: 0 };
    pt.count += n;
    platTotals.set(platKey, pt);
    platLookup.set(`${date}::${platKey}`, (platLookup.get(`${date}::${platKey}`) ?? 0) + n);
  }

  const rankedConn = [...connTotals.entries()].sort((a, b) => b[1].count - a[1].count);
  const top = rankedConn.slice(0, MAX_CONNECTION_SERIES);
  const rest = rankedConn.slice(MAX_CONNECTION_SERIES);
  const connSeries: PainelSeriesMeta[] = top.map(([key, meta], i) => ({
    key,
    label: meta.label,
    color: colorAt(i),
  }));
  if (rest.length) {
    connSeries.push({
      key: "__outras__",
      label: "Outras",
      color: "var(--color-primary-dark)",
    });
    const restKeys = new Set(rest.map(([k]) => k));
    for (const [lk, n] of [...connLookup.entries()]) {
      const [date, key] = lk.split("::");
      if (!restKeys.has(key)) continue;
      const agg = `${date}::__outras__`;
      connLookup.set(agg, (connLookup.get(agg) ?? 0) + n);
    }
  }

  const platSeries: PainelSeriesMeta[] = [...platTotals.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, meta], i) => ({
      key,
      label: meta.label,
      color: PLATFORM_COLORS[key] ?? colorAt(i),
    }));

  const connEmpty = rankedConn.every(([, m]) => m.count === 0) || rankedConn.length === 0;
  const platEmpty = platTotals.size === 0;

  return {
    connections: {
      series: connSeries,
      points: fillDailyPoints(
        days,
        incompleteLast,
        todayKey,
        connSeries.map((s) => s.key),
        connLookup,
      ),
      empty: connEmpty,
    },
    platforms: {
      series: platSeries,
      points: fillDailyPoints(
        days,
        incompleteLast,
        todayKey,
        platSeries.map((s) => s.key),
        platLookup,
      ),
      empty: platEmpty,
    },
  };
}

export async function getPainelServiceExceptions(
  clock: ClockMode,
): Promise<PainelServiceException[]> {
  const now = new Date();
  const bh = await loadPainelHours();
  const noReplyBefore =
    clock === "elapsed"
      ? new Date(now.getTime() - DEFAULT_NO_REPLY_HOURS * 3_600_000)
      : subtractBusinessMs(now, DEFAULT_NO_REPLY_HOURS * 3_600_000, bh);
  const open24hBefore = new Date(now.getTime() - 24 * 3_600_000);

  const [noReply, open24h, unassigned, sendFailure] = await Promise.all([
    prisma.conversation.count({
      where: {
        ...openWhere(),
        lastMessageDirection: "in",
        lastInboundAt: { lte: noReplyBefore },
        hasError: false,
      },
    }),
    prisma.conversation.count({
      where: {
        ...openWhere(),
        createdAt: { lte: open24hBefore },
      },
    }),
    prisma.conversation.count({
      where: { ...openWhere(), assignedToId: null },
    }),
    prisma.conversation.count({
      where: { ...openWhere(), hasError: true },
    }),
  ]);

  return [
    {
      key: "no_reply",
      count: noReply,
      href: `/inbox?tab=esperando&painel=no_reply`,
    },
    {
      key: "open_24h",
      count: open24h,
      href: `/inbox?tab=todos&window=open&painel=open_24h`,
    },
    {
      key: "unassigned",
      count: unassigned,
      href: `/inbox?tab=entrada&owner=none`,
    },
    {
      key: "send_failure",
      count: sendFailure,
      href: `/inbox?tab=erro`,
    },
  ];
}

export type PainelServiceResult = {
  agora: PainelBlock<PainelAgora>;
  volume: PainelBlock<PainelVolume>;
  tempo: PainelBlock<PainelTempo>;
  heatmap: PainelBlock<PainelHeatmap>;
  byDepartment: PainelBlock<PainelByDepartment>;
  connections: PainelBlock<PainelConnections>;
  attendants: PainelBlock<{ rows: PainelAttendantRow[]; attribution: string }>;
  channels: PainelBlock<{ channels: PainelChannelRow[]; motivos: PainelMotivoRow[] }>;
  exceptions: PainelBlock<PainelServiceException[]>;
};

const SERVICE_SECTIONS = [
  "agora",
  "volume",
  "tempo",
  "heatmap",
  "byDepartment",
  "connections",
  "attendants",
  "channels",
  "exceptions",
] as const;
export type PainelServiceSection = (typeof SERVICE_SECTIONS)[number];

export function parseServiceSections(raw: string | null): PainelServiceSection[] {
  if (!raw) return [...SERVICE_SECTIONS];
  const asked = raw.split(",").map((s) => s.trim()) as PainelServiceSection[];
  const next = asked.filter((s): s is PainelServiceSection =>
    (SERVICE_SECTIONS as readonly string[]).includes(s),
  );
  return next.length ? next : [...SERVICE_SECTIONS];
}

export async function getPainelService(
  range: PainelRange,
  clock: ClockMode,
  sections: PainelServiceSection[] = [...SERVICE_SECTIONS],
): Promise<PainelServiceResult> {
  const want = new Set(sections);
  const omit = <T,>(msg = "omitido"): PainelBlock<T> => ({
    ok: false,
    error: msg,
  });

  const needReplyMetrics =
    want.has("tempo") ||
    want.has("attendants") ||
    want.has("byDepartment") ||
    want.has("channels");
  const sharedPromise = needReplyMetrics
    ? loadSharedServiceMetrics(range)
    : Promise.resolve(null);

  const withShared = <T,>(
    needed: boolean,
    fn: (shared: SharedServiceMetrics) => Promise<T>,
  ): Promise<PainelBlock<T>> => {
    if (!needed) return Promise.resolve(omit<T>());
    return sharedPromise.then(
      (shared) => (shared ? wrap(() => fn(shared)) : Promise.resolve(omit<T>())),
      (e) => {
        console.error("[painel/service]", e);
        return omit<T>(e instanceof Error ? e.message : "Falha ao carregar este bloco.");
      },
    );
  };

  const [agora, volume, tempo, heatmap, byDepartment, connections, attendants, channels, exceptions] =
    await Promise.all([
      want.has("agora")
        ? wrap(() => getPainelAgora(clock))
        : Promise.resolve(omit<PainelAgora>()),
      want.has("volume")
        ? wrap(() => getPainelVolume(range, clock))
        : Promise.resolve(omit<PainelVolume>()),
      withShared(want.has("tempo"), (shared) => getPainelTempo(range, clock, shared)),
      want.has("heatmap")
        ? wrap(() => getPainelHeatmap(range))
        : Promise.resolve(omit<PainelHeatmap>()),
      withShared(want.has("byDepartment"), (shared) =>
        getPainelByDepartment(range, clock, shared),
      ),
      want.has("connections")
        ? wrap(() => getPainelConnections(range))
        : Promise.resolve(omit<PainelConnections>()),
      withShared(want.has("attendants"), (shared) =>
        getPainelAttendants(range, clock, shared),
      ),
      withShared(want.has("channels"), (shared) =>
        getPainelChannels(range, clock, shared),
      ),
      want.has("exceptions")
        ? wrap(() => getPainelServiceExceptions(clock))
        : Promise.resolve(omit<PainelServiceException[]>()),
    ]);

  return {
    agora,
    volume,
    tempo,
    heatmap,
    byDepartment,
    connections,
    attendants,
    channels,
    exceptions,
  };
}
