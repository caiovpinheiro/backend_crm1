/**
 * Cards opcionais do painel: mensagens recebidas por consultor ou fase,
 * e tarefas abertas com prazo. Não entra no carregamento padrão do funil.
 */

import { Prisma } from "@prisma/client";

import { analyticsClient } from "@/lib/analytics";
import { getOrgIdOrThrow } from "@/lib/request-context";
import type { PainelRange } from "@/services/painel-period";

const TASK_CAP = 80;

export type InsightUserRow = { id: string; name: string; value: number };

export type InsightStageCard = {
  stageId: string;
  total: number;
  byUser: InsightUserRow[];
};

export type InsightTaskItem = {
  id: string;
  title: string;
  dueAt: string | null;
};

export type InsightTaskGroup = {
  id: string;
  name: string;
  count: number;
  items: InsightTaskItem[];
};

export type PainelInsights = {
  inboundOwners: { total: number; byUser: InsightUserRow[] } | null;
  stages: InsightStageCard[];
  tasks: { group: "user" | "department"; total: number; groups: InsightTaskGroup[] }[];
};

function db() {
  return analyticsClient();
}

export async function getPainelInsights(input: {
  range: PainelRange;
  pipelineIds: string[];
  stageIds: string[];
  inboundOwners: boolean;
  taskGroups: ("user" | "department")[];
}): Promise<PainelInsights> {
  const orgId = getOrgIdOrThrow();
  const pipe = input.pipelineIds;
  const wantInbound = input.inboundOwners || input.stageIds.length > 0;

  const inboundRows = wantInbound && pipe.length
    ? await db().$queryRaw<
        { stageId: string; ownerId: string; ownerName: string; cnt: bigint }[]
      >(Prisma.sql`
        SELECT d."stageId" AS "stageId",
               COALESCE(d."ownerId", '__none__') AS "ownerId",
               COALESCE(u.name, 'Sem consultor') AS "ownerName",
               COUNT(DISTINCT d.id)::bigint AS cnt
        FROM deals d
        INNER JOIN stages s ON s.id = d."stageId"
        LEFT JOIN users u ON u.id = d."ownerId"
        WHERE d."organizationId" = ${orgId}
          AND d.status = 'OPEN'::"DealStatus"
          AND s."pipelineId" IN (${Prisma.join(pipe)})
          AND d."contactId" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM messages m
            INNER JOIN conversations conv ON conv.id = m."conversationId"
            WHERE conv."contactId" = d."contactId"
              AND conv."organizationId" = ${orgId}
              AND m."organizationId" = ${orgId}
              AND m.direction = 'in'
              AND m."createdAt" >= ${input.range.from}
              AND m."createdAt" <= ${input.range.to}
          )
        GROUP BY 1, 2, 3
      `)
    : [];

  const byStage = new Map<string, InsightStageCard>();
  const owners = new Map<string, InsightUserRow>();
  for (const row of inboundRows) {
    const n = Number(row.cnt);
    if (input.stageIds.includes(row.stageId)) {
      const card = byStage.get(row.stageId) ?? { stageId: row.stageId, total: 0, byUser: [] };
      card.total += n;
      card.byUser.push({ id: row.ownerId, name: row.ownerName, value: n });
      byStage.set(row.stageId, card);
    }
    if (input.inboundOwners && row.ownerId !== "__none__") {
      const prev = owners.get(row.ownerId) ?? { id: row.ownerId, name: row.ownerName, value: 0 };
      prev.value += n;
      owners.set(row.ownerId, prev);
    }
  }
  for (const card of byStage.values()) {
    card.byUser.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "pt-BR"));
  }

  const tasks = [];
  for (const group of input.taskGroups) {
    tasks.push(await loadTasks(orgId, input.range, group));
  }

  const ownerRows = [...owners.values()].sort(
    (a, b) => b.value - a.value || a.name.localeCompare(b.name, "pt-BR"),
  );
  return {
    inboundOwners: input.inboundOwners
      ? { total: ownerRows.reduce((s, r) => s + r.value, 0), byUser: ownerRows }
      : null,
    stages: input.stageIds.map(
      (stageId) => byStage.get(stageId) ?? { stageId, total: 0, byUser: [] },
    ),
    tasks,
  };
}

async function loadTasks(
  orgId: string,
  range: PainelRange,
  group: "user" | "department",
): Promise<PainelInsights["tasks"][number]> {
  const rows = await db().$queryRaw<
    {
      id: string;
      title: string;
      scheduledAt: Date | null;
      bucketId: string | null;
      bucketName: string | null;
    }[]
  >(Prisma.sql`
    SELECT a.id AS id, a.title AS title, a."scheduledAt" AS "scheduledAt",
           ${group === "user" ? Prisma.sql`a."userId"` : Prisma.sql`a."departmentId"`} AS "bucketId",
           ${group === "user" ? Prisma.sql`u.name` : Prisma.sql`dep.name`} AS "bucketName"
    FROM activities a
    LEFT JOIN users u ON u.id = a."userId"
    LEFT JOIN departments dep ON dep.id = a."departmentId"
    WHERE a."organizationId" = ${orgId}
      AND a.type = 'TASK'::"ActivityType"
      AND a.completed = false
      AND (
        a."scheduledAt" IS NULL
        OR (a."scheduledAt" >= ${range.from} AND a."scheduledAt" <= ${range.to})
      )
      AND ${group === "user" ? Prisma.sql`a."userId" IS NOT NULL` : Prisma.sql`a."departmentId" IS NOT NULL`}
    ORDER BY a."scheduledAt" ASC NULLS LAST
    LIMIT ${TASK_CAP}
  `);

  const groups = new Map<string, InsightTaskGroup>();
  for (const row of rows) {
    const id = row.bucketId ?? "__none__";
    const g = groups.get(id) ?? {
      id,
      name: row.bucketName?.trim() || (group === "user" ? "Sem responsável" : "Sem departamento"),
      count: 0,
      items: [],
    };
    g.count += 1;
    if (g.items.length < 12) {
      g.items.push({
        id: row.id,
        title: row.title,
        dueAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
      });
    }
    groups.set(id, g);
  }
  const list = [...groups.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR"),
  );
  return {
    group,
    total: list.reduce((s, g) => s + g.count, 0),
    groups: list,
  };
}
