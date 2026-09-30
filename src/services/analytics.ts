import { Prisma, type ActivityType } from "@prisma/client";

// PR 5.2: queries deste service sao read-only e toleram lag — vao
// pra read replica quando configurada (`DATABASE_URL_REPLICA`). Em
// dev/single-node, `analyticsClient()` retorna o primary, comportamento
// inalterado.
import { analyticsClient } from "@/lib/analytics";

const prisma = analyticsClient();
import { getOrgIdOrThrow } from "@/lib/request-context";
import { cache } from "@/lib/cache";
import { stageMetricsKey } from "@/lib/cache/keys";

// Todas as $queryRaw deste arquivo precisam de filtro explicito de
// organizationId — a Prisma Extension nao intercepta SQL cru, e sem o
// filtro um tenant veria agregados de outro. Padrao: capturar orgId no
// topo de cada funcao publica e injetar em cada raw via parametro.

function toNumber(v: unknown): number {
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type AnalyticsPeriod = { from: Date; to: Date };

export async function getDashboardMetrics(period?: AnalyticsPeriod) {
  const orgId = getOrgIdOrThrow();
  const createdFilter = period
    ? { createdAt: { gte: period.from, lte: period.to } }
    : undefined;
  const closedFilter = period
    ? { closedAt: { gte: period.from, lte: period.to } }
    : undefined;

  const [
    totalDeals,
    openDeals,
    wonDeals,
    lostDeals,
    wonAgg,
    pipelineAgg,
    weightedRows,
    cycleRows,
    newContacts,
    activeConversations,
  ] = await Promise.all([
    prisma.deal.count({ where: createdFilter }),
    prisma.deal.count({ where: { status: "OPEN" } }),
    prisma.deal.count({
      where: { status: "WON", ...closedFilter },
    }),
    prisma.deal.count({
      where: { status: "LOST", ...closedFilter },
    }),
    prisma.deal.aggregate({
      where: { status: "WON", ...closedFilter },
      _sum: { value: true },
      _avg: { value: true },
      _count: true,
    }),
    prisma.deal.aggregate({
      where: { status: "OPEN" },
      _sum: { value: true },
    }),
    prisma.$queryRaw<{ w: unknown }[]>`
      SELECT COALESCE(SUM(CAST(d.value AS DECIMAL) * s."winProbability" / 100.0), 0) AS w
      FROM deals d
      INNER JOIN stages s ON s.id = d."stageId"
      WHERE d.status = 'OPEN'::"DealStatus"
        AND d."organizationId" = ${orgId}
    `,
    prisma.deal.findMany({
      where: { status: "WON", closedAt: { not: null }, ...closedFilter },
      select: { createdAt: true, closedAt: true },
    }),
    prisma.contact.count({
      where: period
        ? { createdAt: { gte: period.from, lte: period.to } }
        : {},
    }),
    prisma.conversation.count({ where: { status: "OPEN" } }),
  ]);

  const totalRevenue = toNumber(wonAgg._sum.value);
  const pipelineValue = toNumber(pipelineAgg._sum.value);
  const weightedPipelineValue = toNumber(weightedRows[0]?.w);

  const wonCountForAvg = wonAgg._count;
  const avgDealSize =
    wonCountForAvg > 0 ? round2(toNumber(wonAgg._avg.value)) : 0;

  const decided = wonDeals + lostDeals;
  const conversionRate =
    decided > 0 ? round2((wonDeals / decided) * 100) : 0;

  let avgCycleTime = 0;
  if (cycleRows.length > 0) {
    const sumDays = cycleRows.reduce((acc, row) => {
      if (!row.closedAt) return acc;
      const ms = row.closedAt.getTime() - row.createdAt.getTime();
      return acc + ms / (1000 * 60 * 60 * 24);
    }, 0);
    avgCycleTime = round2(sumDays / cycleRows.length);
  }

  return {
    totalDeals,
    openDeals,
    wonDeals,
    lostDeals,
    totalRevenue: round2(totalRevenue),
    pipelineValue: round2(pipelineValue),
    weightedPipelineValue: round2(weightedPipelineValue),
    avgDealSize,
    conversionRate,
    avgCycleTime,
    newContacts,
    activeConversations,
  };
}

export async function getRevenueOverTime(
  period: AnalyticsPeriod,
  groupBy: "day" | "week" | "month"
) {
  const orgId = getOrgIdOrThrow();
  const unit =
    groupBy === "day" ? "day" : groupBy === "week" ? "week" : "month";

  const rows = await prisma.$queryRaw<
    { bucket: Date; revenue: unknown; count: bigint }[]
  >(Prisma.sql`
    SELECT
      date_trunc(${Prisma.raw(`'${unit}'`)}, d."closedAt") AS bucket,
      COALESCE(SUM(CAST(d.value AS DECIMAL)), 0) AS revenue,
      COUNT(*)::bigint AS count
    FROM deals d
    WHERE d.status = 'WON'::"DealStatus"
      AND d."closedAt" IS NOT NULL
      AND d."closedAt" >= ${period.from}
      AND d."closedAt" <= ${period.to}
      AND d."organizationId" = ${orgId}
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  return rows.map((r) => ({
    date: r.bucket.toISOString(),
    revenue: round2(toNumber(r.revenue)),
    count: Number(r.count),
  }));
}

export type FunnelStageRow = {
  stageName: string;
  stagePosition: number;
  dealCount: number;
  totalValue: number;
  conversionFromPrevious: number | null;
};

export async function getFunnelData(pipelineId: string): Promise<FunnelStageRow[]> {
  const orgId = getOrgIdOrThrow();
  const stages = await prisma.stage.findMany({
    where: { pipelineId },
    orderBy: { position: "asc" },
    select: { id: true, name: true, position: true },
  });

  const rows = await prisma.$queryRaw<
    { stageId: string; dealCount: bigint; totalValue: unknown }[]
  >`
    SELECT
      d."stageId" AS "stageId",
      COUNT(*)::bigint AS "dealCount",
      COALESCE(SUM(CAST(d.value AS DECIMAL)), 0) AS "totalValue"
    FROM deals d
    INNER JOIN stages s ON s.id = d."stageId"
    WHERE s."pipelineId" = ${pipelineId}
      AND d.status = 'OPEN'::"DealStatus"
      AND d."organizationId" = ${orgId}
    GROUP BY d."stageId"
  `;

  const byStage = new Map(
    rows.map((r) => [
      r.stageId,
      { dealCount: Number(r.dealCount), totalValue: toNumber(r.totalValue) },
    ])
  );

  let previousCount: number | null = null;
  return stages.map((st) => {
    const agg = byStage.get(st.id) ?? { dealCount: 0, totalValue: 0 };
    let conversionFromPrevious: number | null = null;
    if (previousCount === null) {
      conversionFromPrevious = null;
    } else if (previousCount > 0) {
      conversionFromPrevious = round2((agg.dealCount / previousCount) * 100);
    } else {
      conversionFromPrevious = agg.dealCount > 0 ? 100 : 0;
    }
    previousCount = agg.dealCount;
    return {
      stageName: st.name,
      stagePosition: st.position,
      dealCount: agg.dealCount,
      totalValue: round2(agg.totalValue),
      conversionFromPrevious,
    };
  });
}

export type TeamPerformanceRow = {
  userId: string;
  userName: string;
  dealsWon: number;
  dealsLost: number;
  revenue: number;
  activitiesCompleted: number;
  avgCycleTime: number;
};

export async function getTeamPerformance(period?: AnalyticsPeriod) {
  const orgId = getOrgIdOrThrow();
  // CORRECAO multi-tenant 24/abr/26: User NAO esta em SCOPED_MODELS,
  // entao precisamos filtrar manualmente por organizationId. O comentario
  // antigo aqui dizia que estava scoped pela extension — era um bug.
  const users = await prisma.user.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const closedFrom = period?.from ?? new Date(0);
  const closedTo = period?.to ?? new Date(8640000000000000);

  const dealStats = await prisma.$queryRaw<
    {
      ownerId: string;
      dealsWon: bigint;
      dealsLost: bigint;
      revenue: unknown;
      avgCycleSec: unknown;
    }[]
  >`
    SELECT
      d."ownerId" AS "ownerId",
      COUNT(*) FILTER (WHERE d.status = 'WON'::"DealStatus")::bigint AS "dealsWon",
      COUNT(*) FILTER (WHERE d.status = 'LOST'::"DealStatus")::bigint AS "dealsLost",
      COALESCE(
        SUM(CAST(d.value AS DECIMAL)) FILTER (WHERE d.status = 'WON'::"DealStatus"),
        0
      ) AS revenue,
      AVG(
        EXTRACT(EPOCH FROM (d."closedAt" - d."createdAt"))
      ) FILTER (WHERE d.status = 'WON'::"DealStatus" AND d."closedAt" IS NOT NULL) AS "avgCycleSec"
    FROM deals d
    WHERE d."ownerId" IS NOT NULL
      AND d.status IN ('WON'::"DealStatus", 'LOST'::"DealStatus")
      AND d."closedAt" IS NOT NULL
      AND d."closedAt" >= ${closedFrom}
      AND d."closedAt" <= ${closedTo}
      AND d."organizationId" = ${orgId}
    GROUP BY d."ownerId"
  `;

  const actFrom = period?.from ?? new Date(0);
  const actTo = period?.to ?? new Date(8640000000000000);

  const actStats = await prisma.$queryRaw<{ userId: string; c: bigint }[]>`
    SELECT a."userId" AS "userId", COUNT(*)::bigint AS c
    FROM activities a
    WHERE a.completed = true
      AND COALESCE(a."completedAt", a."updatedAt") >= ${actFrom}
      AND COALESCE(a."completedAt", a."updatedAt") <= ${actTo}
      AND a."organizationId" = ${orgId}
    GROUP BY a."userId"
  `;

  const dealMap = new Map(dealStats.map((r) => [r.ownerId, r]));
  const actMap = new Map(actStats.map((r) => [r.userId, Number(r.c)]));

  return users.map((u) => {
    const d = dealMap.get(u.id);
    const dealsWon = d ? Number(d.dealsWon) : 0;
    const dealsLost = d ? Number(d.dealsLost) : 0;
    const revenue = d ? round2(toNumber(d.revenue)) : 0;
    const avgCycleSec = d?.avgCycleSec != null ? toNumber(d.avgCycleSec) : 0;
    const avgCycleTime =
      dealsWon > 0 && avgCycleSec > 0 ? round2(avgCycleSec / 86400) : 0;
    return {
      userId: u.id,
      userName: u.name,
      dealsWon,
      dealsLost,
      revenue,
      activitiesCompleted: actMap.get(u.id) ?? 0,
      avgCycleTime,
    };
  });
}

export type LeadSourceRow = {
  source: string;
  contactCount: number;
  dealCount: number;
  revenue: number;
  conversionRate: number;
};

export async function getLeadSources(period?: AnalyticsPeriod) {
  const orgId = getOrgIdOrThrow();
  const cohortFilter = period
    ? Prisma.sql`c."createdAt" >= ${period.from} AND c."createdAt" <= ${period.to} AND c."organizationId" = ${orgId}`
    : Prisma.sql`c."organizationId" = ${orgId}`;

  // Tanto LEFT JOIN deals quanto EXISTS deals2 ja vem amarrados a contacts
  // do cohort (que ja foi filtrado por org). Adicionamos d/d2."organizationId"
  // como defesa em profundidade (paranoia + alinha com RLS quando ativarmos).
  const wonRevenueFilter = period
    ? Prisma.sql`d.status = 'WON'::"DealStatus" AND d."closedAt" IS NOT NULL AND d."closedAt" >= ${period.from} AND d."closedAt" <= ${period.to} AND d."organizationId" = ${orgId}`
    : Prisma.sql`d.status = 'WON'::"DealStatus" AND d."closedAt" IS NOT NULL AND d."organizationId" = ${orgId}`;

  const existsWonFilter = period
    ? Prisma.sql`d2.status = 'WON'::"DealStatus" AND d2."closedAt" IS NOT NULL AND d2."closedAt" >= ${period.from} AND d2."closedAt" <= ${period.to} AND d2."organizationId" = ${orgId}`
    : Prisma.sql`d2.status = 'WON'::"DealStatus" AND d2."closedAt" IS NOT NULL AND d2."organizationId" = ${orgId}`;

  const rows = await prisma.$queryRaw<
    {
      source: string;
      contactCount: bigint;
      dealCount: bigint;
      revenue: unknown;
      contactsWon: bigint;
    }[]
  >(Prisma.sql`
    WITH cohort AS (
      SELECT
        c.id,
        COALESCE(NULLIF(TRIM(c.source), ''), '(sem fonte)') AS src
      FROM contacts c
      WHERE ${cohortFilter}
    )
    SELECT
      cohort.src AS source,
      COUNT(DISTINCT cohort.id)::bigint AS "contactCount",
      COUNT(DISTINCT d.id)::bigint AS "dealCount",
      COALESCE(
        SUM(CAST(d.value AS DECIMAL)) FILTER (WHERE ${wonRevenueFilter}),
        0
      ) AS revenue,
      COUNT(DISTINCT cohort.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM deals d2
          WHERE d2."contactId" = cohort.id
            AND ${existsWonFilter}
        )
      )::bigint AS "contactsWon"
    FROM cohort
    LEFT JOIN deals d ON d."contactId" = cohort.id
    GROUP BY cohort.src
    ORDER BY cohort.src ASC
  `);

  return rows.map((r) => {
    const contactCount = Number(r.contactCount);
    const contactsWon = Number(r.contactsWon);
    return {
      source: r.source,
      contactCount,
      dealCount: Number(r.dealCount),
      revenue: round2(toNumber(r.revenue)),
      conversionRate:
        contactCount > 0 ? round2((contactsWon / contactCount) * 100) : 0,
    };
  });
}

export type SalesForecastResult = {
  forecast: { month: string; predictedRevenue: number }[];
  totalWeightedValue: number;
};

export async function getSalesForecast(
  pipelineId?: string
): Promise<SalesForecastResult> {
  const orgId = getOrgIdOrThrow();
  const pipelineCond = pipelineId
    ? Prisma.sql`AND s."pipelineId" = ${pipelineId}`
    : Prisma.empty;

  const weightedRows = await prisma.$queryRaw<{ w: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(CAST(d.value AS DECIMAL) * s."winProbability" / 100.0), 0) AS w
    FROM deals d
    INNER JOIN stages s ON s.id = d."stageId"
    WHERE d.status = 'OPEN'::"DealStatus"
      AND d."organizationId" = ${orgId}
    ${pipelineCond}
  `);

  const totalWeightedValue = round2(toNumber(weightedRows[0]?.w));

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  const bucketRows = await prisma.$queryRaw<
    { ym: string; weighted: unknown }[]
  >(Prisma.sql`
    SELECT
      TO_CHAR(date_trunc('month', d."expectedClose"), 'YYYY-MM') AS ym,
      COALESCE(SUM(CAST(d.value AS DECIMAL) * s."winProbability" / 100.0), 0) AS weighted
    FROM deals d
    INNER JOIN stages s ON s.id = d."stageId"
    WHERE d.status = 'OPEN'::"DealStatus"
      AND d."expectedClose" IS NOT NULL
      AND d."organizationId" = ${orgId}
      ${pipelineCond}
    GROUP BY 1
  `);

  const bucketMap = new Map(
    bucketRows.map((r) => [r.ym, toNumber(r.weighted)])
  );

  let assigned = 0;
  for (const label of months) {
    assigned += bucketMap.get(label) ?? 0;
  }
  const unassigned = Math.max(0, totalWeightedValue - assigned);
  const split = months.length > 0 ? round2(unassigned / months.length) : 0;

  const forecast = months.map((label) => ({
    month: label,
    predictedRevenue: round2((bucketMap.get(label) ?? 0) + split),
  }));

  return { forecast, totalWeightedValue };
}

export async function getDealsByStatus(period?: AnalyticsPeriod) {
  const closedFilter = period
    ? { closedAt: { gte: period.from, lte: period.to } }
    : undefined;

  const [open, won, lost] = await Promise.all([
    prisma.deal.count({ where: { status: "OPEN" } }),
    prisma.deal.count({
      where: { status: "WON", ...closedFilter },
    }),
    prisma.deal.count({
      where: { status: "LOST", ...closedFilter },
    }),
  ]);

  return { open, won, lost };
}

const ACTIVITY_TYPES: ActivityType[] = [
  "CALL",
  "EMAIL",
  "MEETING",
  "TASK",
  "NOTE",
  "WHATSAPP",
  "OTHER",
];

export async function getActivityStats(period?: AnalyticsPeriod) {
  const timeFilter = period
    ? { gte: period.from, lte: period.to }
    : undefined;

  const where = timeFilter ? { createdAt: timeFilter } : {};

  const [total, completed, pending, byTypeRows] = await Promise.all([
    prisma.activity.count({ where }),
    prisma.activity.count({ where: { ...where, completed: true } }),
    prisma.activity.count({ where: { ...where, completed: false } }),
    prisma.activity.groupBy({
      by: ["type"],
      where,
      _count: { type: true },
    }),
  ]);

  const byTypeCount: Record<string, number> = {};
  for (const t of ACTIVITY_TYPES) {
    byTypeCount[t.toLowerCase()] = 0;
  }
  for (const row of byTypeRows) {
    byTypeCount[row.type.toLowerCase()] = row._count.type;
  }

  return {
    total,
    completed,
    pending,
    byType: byTypeCount as {
      call: number;
      email: number;
      meeting: number;
      task: number;
      note: number;
      whatsapp: number;
      other: number;
    },
  };
}

// ── Inbox / Atendimento Metrics ────────────────────

export type InboxMetrics = {
  totalConversations: number;
  openConversations: number;
  resolvedConversations: number;
  totalMessages: number;
  inboundMessages: number;
  outboundMessages: number;
  avgFirstResponseMinutes: number;
  avgResolutionHours: number;
  byAgent: {
    userId: string;
    userName: string;
    conversations: number;
    messagesSent: number;
    avgResponseMinutes: number;
  }[];
  byChannel: { channel: string; count: number }[];
  byDay: { date: string; inbound: number; outbound: number; conversations: number }[];
  byHour: { hour: number; count: number }[];
};

export async function getInboxMetrics(period?: AnalyticsPeriod): Promise<InboxMetrics> {
  const orgId = getOrgIdOrThrow();
  const from = period?.from ?? new Date(0);
  const to = period?.to ?? new Date(8640000000000000);

  const [
    totalConversations,
    openConversations,
    resolvedConversations,
    totalMessages,
    inboundMessages,
    outboundMessages,
  ] = await Promise.all([
    prisma.conversation.count({ where: { createdAt: { gte: from, lte: to } } }),
    prisma.conversation.count({ where: { status: "OPEN" } }),
    prisma.conversation.count({ where: { status: "RESOLVED", updatedAt: { gte: from, lte: to } } }),
    prisma.message.count({ where: { createdAt: { gte: from, lte: to } } }),
    prisma.message.count({ where: { direction: "in", createdAt: { gte: from, lte: to } } }),
    prisma.message.count({ where: { direction: "out", createdAt: { gte: from, lte: to } } }),
  ]);

  const firstResponseRows = await prisma.$queryRaw<{ avg_minutes: unknown }[]>`
    WITH first_responses AS (
      SELECT
        m_in."conversationId",
        MIN(m_out."createdAt") - m_in."createdAt" AS response_time
      FROM messages m_in
      INNER JOIN messages m_out
        ON m_out."conversationId" = m_in."conversationId"
        AND m_out.direction = 'out'
        AND m_out."createdAt" > m_in."createdAt"
        AND m_out."organizationId" = ${orgId}
      WHERE m_in.direction = 'in'
        AND m_in."createdAt" >= ${from}
        AND m_in."createdAt" <= ${to}
        AND m_in."organizationId" = ${orgId}
        AND NOT EXISTS (
          SELECT 1 FROM messages m_prev
          WHERE m_prev."conversationId" = m_in."conversationId"
            AND m_prev.direction = 'in'
            AND m_prev."createdAt" < m_in."createdAt"
            AND m_prev."createdAt" > m_in."createdAt" - INTERVAL '1 second'
            AND m_prev."organizationId" = ${orgId}
        )
      GROUP BY m_in.id, m_in."conversationId", m_in."createdAt"
    )
    SELECT COALESCE(AVG(EXTRACT(EPOCH FROM response_time) / 60.0), 0) AS avg_minutes
    FROM first_responses
    WHERE response_time IS NOT NULL
  `;
  const avgFirstResponseMinutes = round2(toNumber(firstResponseRows[0]?.avg_minutes));

  const resolutionRows = await prisma.$queryRaw<{ avg_hours: unknown }[]>`
    SELECT COALESCE(
      AVG(EXTRACT(EPOCH FROM (c."updatedAt" - c."createdAt")) / 3600.0),
      0
    ) AS avg_hours
    FROM conversations c
    WHERE c.status = 'RESOLVED'::"ConversationStatus"
      AND c."updatedAt" >= ${from}
      AND c."updatedAt" <= ${to}
      AND c."organizationId" = ${orgId}
  `;
  const avgResolutionHours = round2(toNumber(resolutionRows[0]?.avg_hours));

  // byAgent agora usa conversation.assignedToId (campo correto para atendimento
  // no Inbox) em vez de deal.ownerId. O pipeline comercial continua sendo
  // coberto por /api/analytics/team; aqui é exclusivo de atendimento.
  const agentRows = await prisma.$queryRaw<{
    assignedToId: string;
    assignedName: string;
    conversations: bigint;
    messagesSent: bigint;
    avgRespMin: unknown;
  }[]>`
    WITH agent_convs AS (
      SELECT DISTINCT
        conv."assignedToId",
        u.name AS "assignedName",
        conv.id AS conv_id
      FROM conversations conv
      INNER JOIN users u ON u.id = conv."assignedToId"
      WHERE conv."assignedToId" IS NOT NULL
        AND conv."createdAt" >= ${from} AND conv."createdAt" <= ${to}
        AND conv."organizationId" = ${orgId}
    ),
    agent_msgs AS (
      SELECT
        ac."assignedToId",
        COUNT(*) FILTER (WHERE m.direction = 'out') AS msgs_sent
      FROM agent_convs ac
      INNER JOIN messages m ON m."conversationId" = ac.conv_id
      WHERE m."createdAt" >= ${from} AND m."createdAt" <= ${to}
      GROUP BY ac."assignedToId"
    ),
    agent_resp AS (
      SELECT
        ac."assignedToId",
        AVG(EXTRACT(EPOCH FROM (m_out."createdAt" - m_in."createdAt")) / 60.0) AS avg_resp
      FROM agent_convs ac
      INNER JOIN messages m_in ON m_in."conversationId" = ac.conv_id AND m_in.direction = 'in'
      INNER JOIN LATERAL (
        SELECT m2."createdAt"
        FROM messages m2
        WHERE m2."conversationId" = m_in."conversationId"
          AND m2.direction = 'out'
          AND m2."createdAt" > m_in."createdAt"
        ORDER BY m2."createdAt" ASC
        LIMIT 1
      ) m_out ON true
      WHERE m_in."createdAt" >= ${from} AND m_in."createdAt" <= ${to}
      GROUP BY ac."assignedToId"
    )
    SELECT
      ac."assignedToId",
      ac."assignedName",
      COUNT(DISTINCT ac.conv_id)::bigint AS conversations,
      COALESCE(am.msgs_sent, 0)::bigint AS "messagesSent",
      COALESCE(ar.avg_resp, 0) AS "avgRespMin"
    FROM agent_convs ac
    LEFT JOIN agent_msgs am ON am."assignedToId" = ac."assignedToId"
    LEFT JOIN agent_resp ar ON ar."assignedToId" = ac."assignedToId"
    GROUP BY ac."assignedToId", ac."assignedName", am.msgs_sent, ar.avg_resp
    ORDER BY conversations DESC
  `;

  const byAgent = agentRows.map((r) => ({
    userId: r.assignedToId,
    userName: r.assignedName,
    conversations: Number(r.conversations),
    messagesSent: Number(r.messagesSent),
    avgResponseMinutes: round2(toNumber(r.avgRespMin)),
  }));

  const channelRows = await prisma.conversation.groupBy({
    by: ["channel"],
    where: { createdAt: { gte: from, lte: to } },
    _count: { channel: true },
    orderBy: { _count: { channel: "desc" } },
  });
  const byChannel = channelRows.map((r) => ({
    channel: r.channel,
    count: r._count.channel,
  }));

  const dailyRows = await prisma.$queryRaw<{
    d: Date;
    inbound: bigint;
    outbound: bigint;
    convs: bigint;
  }[]>`
    SELECT
      date_trunc('day', m."createdAt") AS d,
      COUNT(*) FILTER (WHERE m.direction = 'in')::bigint AS inbound,
      COUNT(*) FILTER (WHERE m.direction = 'out')::bigint AS outbound,
      COUNT(DISTINCT m."conversationId")::bigint AS convs
    FROM messages m
    WHERE m."createdAt" >= ${from} AND m."createdAt" <= ${to}
      AND m."organizationId" = ${orgId}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  const byDay = dailyRows.map((r) => ({
    date: r.d.toISOString().split("T")[0],
    inbound: Number(r.inbound),
    outbound: Number(r.outbound),
    conversations: Number(r.convs),
  }));

  const hourlyRows = await prisma.$queryRaw<{ h: number; cnt: bigint }[]>`
    SELECT
      EXTRACT(HOUR FROM m."createdAt") AS h,
      COUNT(*)::bigint AS cnt
    FROM messages m
    WHERE m.direction = 'in'
      AND m."createdAt" >= ${from} AND m."createdAt" <= ${to}
      AND m."organizationId" = ${orgId}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  const byHour = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: Number(hourlyRows.find((r) => Number(r.h) === i)?.cnt ?? 0),
  }));

  return {
    totalConversations,
    openConversations,
    resolvedConversations,
    totalMessages,
    inboundMessages,
    outboundMessages,
    avgFirstResponseMinutes,
    avgResolutionHours,
    byAgent,
    byChannel,
    byDay,
    byHour,
  };
}

// ── Stage Metrics (for Kanban headers) ────────────

export type StageMetric = {
  stageId: string;
  conversionRate: number;
  avgDaysInStage: number;
};

export async function getStageMetrics(pipelineId: string): Promise<StageMetric[]> {
  const orgId = getOrgIdOrThrow();
  // Cache-aside: este calculo agrega os deals abertos do pipeline e roda em
  // CADA carga do board. Sob rajada (dezenas de loads iguais em segundos),
  // o cache reduz para 1 computacao a cada STAGE_METRICS_TTL_SEC.
  return cache.wrap(stageMetricsKey(orgId, pipelineId), STAGE_METRICS_TTL_SEC, () =>
    computeStageMetrics(orgId, pipelineId),
  );
}

/**
 * 300 s: com 20 funis ativos, 60 s eram 20 agregações por minuto. A média
 * de dias dos cards abertos muda devagar; o cabeçalho tolera 5 min.
 */
export const STAGE_METRICS_TTL_SEC = 300;

async function computeStageMetrics(
  orgId: string,
  pipelineId: string,
): Promise<StageMetric[]> {
  // Agregação enxuta: um único GROUP BY sobre os deals do pipeline.
  //
  // Perf: a versão anterior calculava `advancedDeals` com uma subquery
  // correlata `deal_id IN (SELECT id FROM deals WHERE ...)` que fazia um
  // scan da tabela `deals` inteira (76k+ linhas) a cada carga do board —
  // estourava o parallel gather no /dev/shm (PgSQL 53100) e derrubava a
  // conexão. Além de cara, a subquery era um no-op: `"stageId" != deals."stageId"`
  // referenciava a própria tabela da subquery (sempre falso), então
  // `advancedDeals`/`conversionRate` SEMPRE resultavam 0. Mantemos o mesmo
  // resultado (`advancedDeals = 0`) sem o scan.
  //
  // Só deals OPEN: o board mostra as colunas com os cards abertos, e
  // `avgDaysInStage` é a idade média desses cards (o frontend só tipa o
  // campo; não há tela que mostre a média dos fechados). Antes a agregação
  // varria o histórico inteiro do funil (WON/LOST desde sempre) a cada
  // carga — índice `(organizationId, stageId, status)` passa a servir.
  const rows = await prisma.$queryRaw<
    { stageId: string; totalDeals: bigint; advancedDeals: bigint; avgDays: unknown }[]
  >`
    SELECT
      d."stageId",
      COUNT(*)::bigint AS "totalDeals",
      0::bigint AS "advancedDeals",
      COALESCE(AVG(
        EXTRACT(EPOCH FROM (NOW() - d."createdAt")) / 86400.0
      ), 0) AS "avgDays"
    FROM deals d
    INNER JOIN stages s ON s.id = d."stageId"
    WHERE s."pipelineId" = ${pipelineId}
      AND d."organizationId" = ${orgId}
      AND d.status = 'OPEN'::"DealStatus"
    GROUP BY d."stageId"
  `;

  return rows.map((r) => {
    const total = Number(r.totalDeals);
    const advanced = Number(r.advancedDeals);
    return {
      stageId: r.stageId,
      conversionRate: total > 0 ? round2((advanced / total) * 100) : 0,
      avgDaysInStage: round2(toNumber(r.avgDays)),
    };
  });
}
