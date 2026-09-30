/**
 * Recorte operacional do dashboard — só o que o usuário logado precisa fazer.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

const LIST_LIMIT = 8;

export type DashboardMeItem = {
  id: string;
  number: number | null;
  title: string;
  subtitle: string | null;
  href: string;
  meta: string | null;
};

export type DashboardMeStageCount = {
  stageId: string;
  stageName: string;
  pipelineName: string;
  pipelineNumber: number;
  count: number;
};

export type DashboardMeResult = {
  conversations: { total: number; items: DashboardMeItem[] };
  activities: { overdue: number; today: number; items: DashboardMeItem[] };
  stalled: { total: number; items: DashboardMeItem[] };
  /** Mensagens de entrada sem resposta humana, nos negócios OPEN do usuário, por etapa. */
  inboundByStage: DashboardMeStageCount[];
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function daysAgoLabel(from: Date) {
  const days = Math.max(0, Math.floor((Date.now() - from.getTime()) / 86_400_000));
  if (days <= 0) return "hoje";
  if (days === 1) return "1 dia";
  return `${days} dias`;
}

export async function getDashboardMe(userId: string): Promise<DashboardMeResult> {
  const orgId = getOrgIdOrThrow();
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const waitingWhere = {
    assignedToId: userId,
    status: "OPEN" as const,
    lastMessageDirection: "in",
    hasError: false,
  };

  const [waitingTotal, waitingRows, overdue, dueToday, openTasks, stalledRows, stalledTotal, inboundRows] =
    await Promise.all([
      prisma.conversation.count({ where: waitingWhere }),
      prisma.conversation.findMany({
        where: waitingWhere,
        orderBy: { updatedAt: "desc" },
        take: LIST_LIMIT,
        select: {
          id: true,
          number: true,
          updatedAt: true,
          contact: { select: { name: true } },
        },
      }),
      prisma.activity.count({
        where: {
          userId,
          type: "TASK",
          completed: false,
          scheduledAt: { lt: now },
        },
      }),
      prisma.activity.count({
        where: {
          userId,
          type: "TASK",
          completed: false,
          scheduledAt: { gte: todayStart, lte: todayEnd },
        },
      }),
      prisma.activity.findMany({
        where: { userId, type: "TASK", completed: false },
        orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
        take: 40,
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          contact: { select: { name: true } },
          deal: { select: { title: true } },
        },
      }),
      prisma.$queryRaw<
        {
          id: string;
          number: number;
          title: string;
          value: unknown;
          updatedAt: Date;
          stageName: string;
          stageColor: string;
        }[]
      >(Prisma.sql`
        SELECT d.id, d.number, d.title, d.value, d."updatedAt",
               s.name AS "stageName", s.color AS "stageColor"
        FROM deals d
        INNER JOIN stages s ON s.id = d."stageId"
        WHERE d."organizationId" = ${orgId}
          AND d."ownerId" = ${userId}
          AND d.status = 'OPEN'
          AND d."updatedAt" < (NOW() - (s."rottingDays" * INTERVAL '1 day'))
        ORDER BY d."updatedAt" ASC
        LIMIT 8
      `),
      prisma.$queryRaw<{ c: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS c
        FROM deals d
        INNER JOIN stages s ON s.id = d."stageId"
        WHERE d."organizationId" = ${orgId}
          AND d."ownerId" = ${userId}
          AND d.status = 'OPEN'
          AND d."updatedAt" < (NOW() - (s."rottingDays" * INTERVAL '1 day'))
      `),
      // Não usa a fila do inbox (assignedTo). Conta mensagem de entrada ainda
      // sem resposta humana no negócio OPEN mais recente de cada contato do usuário.
      prisma.$queryRaw<
        {
          stageId: string;
          stageName: string;
          pipelineName: string;
          pipelineNumber: number;
          cnt: bigint;
        }[]
      >(Prisma.sql`
        WITH mine AS (
          SELECT DISTINCT ON (d."contactId")
            d."contactId" AS "contactId",
            d."stageId" AS "stageId"
          FROM deals d
          WHERE d."organizationId" = ${orgId}
            AND d."ownerId" = ${userId}
            AND d.status = 'OPEN'::"DealStatus"
            AND d."contactId" IS NOT NULL
          ORDER BY d."contactId", d."updatedAt" DESC
        )
        SELECT s.id AS "stageId",
               s.name AS "stageName",
               p.name AS "pipelineName",
               p.number AS "pipelineNumber",
               COUNT(m.id)::bigint AS cnt
        FROM mine o
        INNER JOIN stages s ON s.id = o."stageId"
        INNER JOIN pipelines p ON p.id = s."pipelineId" AND p."archivedAt" IS NULL
        INNER JOIN conversations conv
          ON conv."contactId" = o."contactId"
         AND conv."organizationId" = ${orgId}
        INNER JOIN messages m
          ON m."conversationId" = conv.id
         AND m."organizationId" = ${orgId}
         AND m.direction = 'in'
         AND m."isPrivate" = false
         AND NOT EXISTS (
           SELECT 1 FROM messages reply
           WHERE reply."conversationId" = m."conversationId"
             AND reply."organizationId" = ${orgId}
             AND reply.direction = 'out'
             AND reply."isPrivate" = false
             AND reply."authorType" = 'human'::"MessageAuthorType"
             AND reply."createdAt" > m."createdAt"
         )
        GROUP BY s.id, s.name, s.position, p.name, p.number
        ORDER BY p.name ASC, s.position ASC
      `),
    ]);

  const rankedTasks = [...openTasks].sort((a, b) => {
    const aOver = a.scheduledAt && a.scheduledAt < now ? 0 : 1;
    const bOver = b.scheduledAt && b.scheduledAt < now ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    const at = a.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = b.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  return {
    conversations: {
      total: waitingTotal,
      items: waitingRows.map((row) => ({
        id: row.id,
        number: row.number ?? null,
        title: row.contact?.name || `Conversa #${row.number ?? ""}`.trim(),
        subtitle: "Aguardando sua resposta",
        href: row.number ? `/inbox?tab=esperando&c=${row.number}` : `/inbox?tab=esperando`,
        meta: daysAgoLabel(row.updatedAt),
      })),
    },
    activities: {
      overdue,
      today: dueToday,
      items: rankedTasks.slice(0, LIST_LIMIT).map((row) => {
        const overdueItem = Boolean(row.scheduledAt && row.scheduledAt < now);
        return {
          id: row.id,
          number: null,
          title: row.title,
          subtitle: row.contact?.name ?? row.deal?.title ?? null,
          href: "/activities",
          meta: overdueItem
            ? "Atrasada"
            : row.scheduledAt
              ? row.scheduledAt.toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Sem prazo",
        };
      }),
    },
    stalled: {
      total: Number(stalledTotal[0]?.c ?? 0),
      items: stalledRows.map((row) => ({
        id: row.id,
        number: row.number,
        title: row.title,
        subtitle: row.stageName,
        href: `/pipeline?deal=${row.number}`,
        meta: daysAgoLabel(row.updatedAt),
      })),
    },
    inboundByStage: inboundRows.map((row) => ({
      stageId: row.stageId,
      stageName: row.stageName,
      pipelineName: row.pipelineName,
      pipelineNumber: row.pipelineNumber,
      count: Number(row.cnt),
    })),
  };
}
