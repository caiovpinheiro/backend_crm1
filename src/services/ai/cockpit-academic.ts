/**
 * Métricas do cockpit — abas do agente acadêmico (hoje, fuso SP).
 * Somente leitura. Falha em qualquer query devolve zeros para não derrubar o painel.
 */

import { prismaBase } from "@/lib/prisma-base";
import { IDLE_NUDGE_SIGNATURE } from "@/services/ai/idle-followup";

export type NamedCount = { name: string; n: number };

export type AcademicCockpit = {
  saude: {
    agentActive: boolean;
    agentName: string | null;
    spokeToday: number;
    attendingNow: number;
    resolvedSoloToday: number;
    handoffToday: number;
    sendFailedToday: number;
    firstResponseMedianSec: number | null;
  };
  resolucao: {
    closedByAiToday: number;
    closedByIdle: number;
    closedByStudentAsk: number;
    idleNudgesToday: number;
    returnedAfterAiClose: number;
  };
  handoff: {
    totalToday: number;
    byDepartment: NamedCount[];
    byKind: NamedCount[];
  };
  funil: {
    academicChannelSpoke: number;
    otherChannelSpoke: number;
    byStage: NamedCount[];
    leadDeEntradaOpen: number;
    leadDeEntradaWithAi: number;
  };
};

const EMPTY: AcademicCockpit = {
  saude: {
    agentActive: false,
    agentName: null,
    spokeToday: 0,
    attendingNow: 0,
    resolvedSoloToday: 0,
    handoffToday: 0,
    sendFailedToday: 0,
    firstResponseMedianSec: null,
  },
  resolucao: {
    closedByAiToday: 0,
    closedByIdle: 0,
    closedByStudentAsk: 0,
    idleNudgesToday: 0,
    returnedAfterAiClose: 0,
  },
  handoff: { totalToday: 0, byDepartment: [], byKind: [] },
  funil: {
    academicChannelSpoke: 0,
    otherChannelSpoke: 0,
    byStage: [],
    leadDeEntradaOpen: 0,
    leadDeEntradaWithAi: 0,
  },
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

function classifyHandoffDept(name: string | null): string {
  const t = (name ?? "").toLowerCase();
  if (!t.trim()) return "Sem departamento";
  if (t.includes("reten")) return "Retenção";
  if (t.includes("acolh")) return "Acolhimento";
  if (t.includes("sac") || t.includes("atendimento")) return "Atendimento / SAC";
  return name!.trim();
}

export function classifyCloseReason(reason: string | null): "idle" | "student" | "other" {
  const t = (reason ?? "").toLowerCase();
  if (
    t.includes("30 min") ||
    t.includes("check-in") ||
    t.includes("silêncio") ||
    t.includes("silencio") ||
    t.includes("sem retorno")
  ) {
    return "idle";
  }
  if (
    t.includes("encerrar") ||
    t.includes("finalizar") ||
    t.includes("só isso") ||
    t.includes("so isso") ||
    t.includes("não preciso") ||
    t.includes("nao preciso")
  ) {
    return "student";
  }
  return "other";
}

export async function getAcademicCockpitMetrics(args: {
  organizationId: string;
  since: Date;
  attendingNow: number;
}): Promise<AcademicCockpit> {
  const orgId = args.organizationId;
  const since = args.since;

  try {
    const [
      agentRow,
      spokeRow,
      failedRow,
      medianRow,
      handoffRows,
      closeRows,
      nudgeRow,
      returnedRow,
      channelRows,
      stageRows,
      leadRows,
    ] = await Promise.all([
      prismaBase.aIAgentConfig.findFirst({
        where: { organizationId: orgId, active: true },
        select: { user: { select: { name: true } }, active: true },
        orderBy: { userId: "asc" },
      }),
      prismaBase.$queryRaw<[{ n: bigint }]>`
        SELECT COUNT(DISTINCT m."conversationId")::bigint AS n
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        WHERE c."organizationId" = ${orgId}
          AND m."authorType" = 'bot'
          AND COALESCE(m."isPrivate", false) = false
          AND m."createdAt" >= ${since}
      `,
      prismaBase.$queryRaw<[{ n: bigint }]>`
        SELECT COUNT(*)::bigint AS n
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        WHERE c."organizationId" = ${orgId}
          AND m.direction = 'out'
          AND m."authorType" = 'bot'
          AND m."createdAt" >= ${since}
          AND m."sendStatus" IN ('failed', 'error', 'FAILED', 'ERROR')
      `,
      prismaBase.$queryRaw<[{ median_sec: number | null }]>`
        WITH firsts AS (
          SELECT
            m."conversationId",
            MIN(m."createdAt") FILTER (WHERE m.direction = 'in') AS first_in,
            MIN(m."createdAt") FILTER (WHERE m."authorType" = 'bot') AS first_bot
          FROM messages m
          JOIN conversations c ON c.id = m."conversationId"
          WHERE c."organizationId" = ${orgId}
            AND c."createdAt" >= ${since}
          GROUP BY m."conversationId"
        )
        SELECT percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (first_bot - first_in))
        ) AS median_sec
        FROM firsts
        WHERE first_in IS NOT NULL
          AND first_bot IS NOT NULL
          AND first_bot >= first_in
      `,
      prismaBase.$queryRaw<
        { dept: string | null; reason: string; n: bigint }[]
      >`
        SELECT d.name AS dept, l.reason, COUNT(*)::bigint AS n
        FROM distribution_logs l
        LEFT JOIN departments d ON d.id = l."departmentId"
        WHERE l."organizationId" = ${orgId}
          AND l.success = true
          AND l."createdAt" >= ${since}
          AND l."triggerSource" ILIKE '%AI_AGENT%'
        GROUP BY d.name, l.reason
      `,
      prismaBase.$queryRaw<{ reason: string | null; n: bigint }[]>`
        SELECT COALESCE(ae.meta->>'reason', '') AS reason, COUNT(*)::bigint AS n
        FROM activity_events ae
        WHERE ae."organizationId" = ${orgId}
          AND ae.type = 'CONVERSATION_CLOSED'
          AND ae."occurredAt" >= ${since}
          AND COALESCE(ae.meta->>'action', '') = 'ai_close'
        GROUP BY 1
      `,
      prismaBase.$queryRaw<[{ n: bigint }]>`
        SELECT COUNT(*)::bigint AS n
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        WHERE c."organizationId" = ${orgId}
          AND m.direction = 'out'
          AND m."authorType" = 'bot'
          AND m."createdAt" >= ${since}
          AND m.content ILIKE ${"%" + IDLE_NUDGE_SIGNATURE + "%"}
      `,
      prismaBase.$queryRaw<[{ n: bigint }]>`
        SELECT COUNT(DISTINCT ae."contactId")::bigint AS n
        FROM activity_events ae
        JOIN conversations c2
          ON c2."contactId" = ae."contactId"
         AND c2."organizationId" = ae."organizationId"
         AND c2."createdAt" > ae."occurredAt"
        WHERE ae."organizationId" = ${orgId}
          AND ae.type = 'CONVERSATION_CLOSED'
          AND ae."occurredAt" >= ${since}
          AND COALESCE(ae.meta->>'action', '') = 'ai_close'
          AND ae."contactId" IS NOT NULL
      `,
      prismaBase.$queryRaw<{ bucket: string; n: bigint }[]>`
        SELECT
          CASE
            WHEN COALESCE(ch.name, '') ILIKE '%acad%' THEN 'academico'
            ELSE 'outro'
          END AS bucket,
          COUNT(DISTINCT m."conversationId")::bigint AS n
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        LEFT JOIN channels ch ON ch.id = COALESCE(m."channelId", c."channelId")
        WHERE c."organizationId" = ${orgId}
          AND m."authorType" = 'bot'
          AND COALESCE(m."isPrivate", false) = false
          AND m."createdAt" >= ${since}
        GROUP BY 1
      `,
      prismaBase.$queryRaw<{ name: string; n: bigint }[]>`
        SELECT COALESCE(st.name, '(sem etapa)') AS name, COUNT(DISTINCT d.id)::bigint AS n
        FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        JOIN deals d
          ON d."contactId" = c."contactId"
         AND d.status = 'OPEN'
        LEFT JOIN stages st ON st.id = d."stageId"
        WHERE c."organizationId" = ${orgId}
          AND m."authorType" = 'bot'
          AND m."createdAt" >= ${since}
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 12
      `,
      prismaBase.$queryRaw<[{ open: bigint; with_ai: bigint }]>`
        SELECT
          COUNT(*)::bigint AS open,
          COUNT(*) FILTER (WHERE u.type = 'AI')::bigint AS with_ai
        FROM deals d
        JOIN stages st ON st.id = d."stageId"
        LEFT JOIN conversations c
          ON c."contactId" = d."contactId"
         AND c.status = 'OPEN'
        LEFT JOIN users u ON u.id = c."assignedToId"
        WHERE d."organizationId" = ${orgId}
          AND d.status = 'OPEN'
          AND (st.slug = 'lead-de-entrada' OR st.name ILIKE 'lead de entrada')
      `,
    ]);

    const spokeToday = n(spokeRow[0]?.n);
    const sendFailedToday = n(failedRow[0]?.n);
    const medianRaw = medianRow[0]?.median_sec;
    const firstResponseMedianSec =
      medianRaw == null || !Number.isFinite(Number(medianRaw))
        ? null
        : Math.round(Number(medianRaw));

    const handoffToday = handoffRows.reduce((s, r) => s + n(r.n), 0);
    const byDeptMap = new Map<string, number>();
    const byKindMap = new Map<string, number>();
    for (const r of handoffRows) {
      const dept = classifyHandoffDept(r.dept);
      byDeptMap.set(dept, (byDeptMap.get(dept) ?? 0) + n(r.n));
      const kind =
        r.reason === "ASSIGNED"
          ? "Atribuído"
          : r.reason === "NO_ELIGIBLE_RESPONSIBLE"
            ? "Sem consultor elegível"
            : r.reason || "Outro";
      byKindMap.set(kind, (byKindMap.get(kind) ?? 0) + n(r.n));
    }

    let closedByAiToday = 0;
    let closedByIdle = 0;
    let closedByStudentAsk = 0;
    for (const r of closeRows) {
      const c = n(r.n);
      closedByAiToday += c;
      const k = classifyCloseReason(r.reason);
      if (k === "idle") closedByIdle += c;
      else if (k === "student") closedByStudentAsk += c;
    }

    const academicChannelSpoke = n(
      channelRows.find((r) => r.bucket === "academico")?.n,
    );
    const otherChannelSpoke = n(
      channelRows.find((r) => r.bucket === "outro")?.n,
    );

    return {
      saude: {
        agentActive: !!agentRow?.active,
        agentName: agentRow?.user?.name ?? null,
        spokeToday,
        attendingNow: args.attendingNow,
        resolvedSoloToday: closedByAiToday,
        handoffToday,
        sendFailedToday,
        firstResponseMedianSec,
      },
      resolucao: {
        closedByAiToday,
        closedByIdle,
        closedByStudentAsk,
        idleNudgesToday: n(nudgeRow[0]?.n),
        returnedAfterAiClose: n(returnedRow[0]?.n),
      },
      handoff: {
        totalToday: handoffToday,
        byDepartment: [...byDeptMap.entries()]
          .map(([name, count]) => ({ name, n: count }))
          .sort((a, b) => b.n - a.n),
        byKind: [...byKindMap.entries()]
          .map(([name, count]) => ({ name, n: count }))
          .sort((a, b) => b.n - a.n),
      },
      funil: {
        academicChannelSpoke,
        otherChannelSpoke,
        byStage: stageRows.map((r) => ({ name: r.name, n: n(r.n) })),
        leadDeEntradaOpen: n(leadRows[0]?.open),
        leadDeEntradaWithAi: n(leadRows[0]?.with_ai),
      },
    };
  } catch (e) {
    console.error("[cockpit] métricas do agente acadêmico falharam", e);
    return {
      ...EMPTY,
      saude: { ...EMPTY.saude, attendingNow: args.attendingNow },
    };
  }
}
