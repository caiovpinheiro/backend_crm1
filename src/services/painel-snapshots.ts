/**
 * Grava o snapshot diário de negócios OPEN por etapa.
 * Sem isso a evolução empilhada do Painel não existe — não reconstruímos
 * o passado a partir do estado atual.
 */

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrThrow, runWithContext } from "@/lib/request-context";
import {
  dayKeyFromDate,
  parseDay,
  SNAPSHOT_RETENTION_DAYS,
} from "@/services/painel-period";

export async function recordDealStageSnapshots(now = new Date()): Promise<{
  orgs: number;
  rows: number;
  pruned: number;
  date: string;
}> {
  const dateKey = dayKeyFromDate(now);
  const date = parseDay(dateKey, false);
  if (!date) {
    return { orgs: 0, rows: 0, pruned: 0, date: dateKey };
  }

  const orgs = await prismaBase.organization.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });

  let rows = 0;
  let pruned = 0;

  for (const { id: organizationId } of orgs) {
    const result = await runWithContext(
      {
        organizationId,
        userId: "system",
        isSuperAdmin: false,
        actor: {
          type: "SYSTEM",
          label: "Painel",
          sublabel: "cron:deal-stage-snapshot",
        },
      },
      () => recordOrgSnapshot(organizationId, date, dateKey),
    );
    rows += result.rows;
    pruned += result.pruned;
  }

  return { orgs: orgs.length, rows, pruned, date: dateKey };
}

async function recordOrgSnapshot(
  organizationId: string,
  date: Date,
  dateKey: string,
): Promise<{ rows: number; pruned: number }> {
  const agg = await prismaBase.$queryRaw<
    { pipelineId: string; stageId: string; cnt: bigint; val: unknown }[]
  >(Prisma.sql`
    SELECT s."pipelineId" AS "pipelineId",
           s.id AS "stageId",
           COUNT(d.id)::bigint AS cnt,
           COALESCE(SUM(CAST(d.value AS DECIMAL)), 0) AS val
    FROM stages s
    INNER JOIN pipelines p ON p.id = s."pipelineId"
    LEFT JOIN deals d
      ON d."stageId" = s.id
     AND d."organizationId" = ${organizationId}
     AND d.status = 'OPEN'::"DealStatus"
    WHERE s."organizationId" = ${organizationId}
      AND p."archivedAt" IS NULL
    GROUP BY s."pipelineId", s.id
  `);

  if (agg.length === 0) {
    return { rows: 0, pruned: await pruneOrg(organizationId, dateKey) };
  }

  const values = agg.map((r) => {
    const openCount = Number(r.cnt);
    const openValue = Number(r.val ?? 0);
    return Prisma.sql`(
      ${randomUUID()},
      ${organizationId},
      ${r.pipelineId},
      ${r.stageId},
      ${date}::date,
      ${openCount},
      ${openValue}
    )`;
  });

  try {
    await prismaBase.$executeRaw`
      INSERT INTO deal_stage_daily_snapshots
        (id, "organizationId", "pipelineId", "stageId", date, "openCount", "openValue")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("organizationId", "stageId", date)
      DO UPDATE SET
        "pipelineId" = EXCLUDED."pipelineId",
        "openCount" = EXCLUDED."openCount",
        "openValue" = EXCLUDED."openValue"
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/42P01|deal_stage_daily_snapshots/i.test(msg)) {
      console.error("[painel/snapshots] tabela ausente — rode a migration deal_stage_daily_snapshots");
      return { rows: 0, pruned: 0 };
    }
    throw e;
  }

  return {
    rows: agg.length,
    pruned: await pruneOrg(organizationId, dateKey),
  };
}

/** Grava o snapshot de hoje da org do request — começa o histórico sem esperar o cron. */
export async function ensureTodayDealStageSnapshot(): Promise<{ date: string; rows: number }> {
  const organizationId = getOrgIdOrThrow();
  const dateKey = dayKeyFromDate(new Date());
  const date = parseDay(dateKey, false);
  if (!date) return { date: dateKey, rows: 0 };
  const result = await recordOrgSnapshot(organizationId, date, dateKey);
  return { date: dateKey, rows: result.rows };
}

async function pruneOrg(organizationId: string, dateKey: string): Promise<number> {
  const cutoff = parseDay(dateKey, false);
  if (!cutoff) return 0;
  cutoff.setDate(cutoff.getDate() - SNAPSHOT_RETENTION_DAYS);
  try {
    const result = await prismaBase.$executeRaw`
      DELETE FROM deal_stage_daily_snapshots
      WHERE "organizationId" = ${organizationId}
        AND date < ${cutoff}::date
    `;
    return Number(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/42P01|deal_stage_daily_snapshots/i.test(msg)) return 0;
    throw e;
  }
}
