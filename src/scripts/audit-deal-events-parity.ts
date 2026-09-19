/**
 * Auditoria de paridade deal_events → activity_events.
 *
 * Compara contagens e dimensoes (stageId/pipelineId) entre as duas tabelas
 * por organizacao e dia. Nao modifica dados.
 *
 * Uso:
 *   pnpm tsx src/scripts/audit-deal-events-parity.ts --from=2026-09-10 --to=2026-09-17
 *   pnpm tsx src/scripts/audit-deal-events-parity.ts --org=<id> --from=2026-09-10 --to=2026-09-17 --sample=10
 *   pnpm tsx src/scripts/audit-deal-events-parity.ts --from=2026-09-10 --to=2026-09-17 --format=csv --output=parity.csv
 */

import type { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const fromDate = argValue("from");
const toDate = argValue("to");
const orgId = argValue("org");
const sampleSize = Math.max(0, Number(argValue("sample") ?? "5"));
const format = argValue("format") ?? "md";
const outputPath = argValue("output");

if (!fromDate || !toDate) {
  console.error("Usage: --from=YYYY-MM-DD --to=YYYY-MM-DD [--org=<id>] [--sample=5] [--format=md|csv] [--output=path]");
  process.exit(1);
}

const TYPES = ["CREATED", "STAGE_CHANGED"] as const;

type RowCounts = {
  orgId: string;
  day: Date;
  type: string;
  dealCount: number;
  activityCount: number;
  dealStageIds: (string | null)[];
  activityToStageIds: (string | null)[];
  dealPipelineIds: (string | null)[];
  activityPipelineIds: (string | null)[];
};

async function main() {
  if (!fromDate || !toDate) {
    console.error("Usage: --from=YYYY-MM-DD --to=YYYY-MM-DD [--org=<id>] [--sample=5] [--format=md|csv] [--output=path]");
    process.exit(1);
  }
  const fromTs = new Date(fromDate);
  const toTs = new Date(`${toDate}T23:59:59.999Z`);

  const { prismaBase } = await import("@/lib/prisma-base");

  const orgs = orgId
    ? [orgId]
    : (
        await prismaBase.organization.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
          take: 50,
        })
      ).map((o) => o.id);

  const rows: RowCounts[] = [];
  for (const currentOrgId of orgs) {
    for (const type of TYPES) {
      const dealAgg =         await prismaBase.$queryRaw<{
        day: Date;
        count: bigint;
        stageIds: (string | null)[];
        pipelineIds: (string | null)[];
      }[]>`
        SELECT
          date_trunc('day', e."createdAt")::date AS day,
          COUNT(*) AS count,
          array_agg(DISTINCT (
            CASE
              WHEN e.type = 'STAGE_CHANGED' THEN e.meta->'to'->>'id'
              WHEN e.type = 'CREATED' THEN e.meta->>'stageId'
              ELSE NULL
            END
          )) AS "stageIds",
          array_agg(DISTINCT (
            CASE
              WHEN e.type = 'STAGE_CHANGED' THEN e.meta->'to'->>'pipelineId'
              ELSE NULL
            END
          )) AS "pipelineIds"
        FROM deal_events e
        WHERE e."organizationId" = ${currentOrgId}
          AND e.type = ${type}
          AND e."createdAt" >= ${fromTs.toISOString()}::timestamptz
          AND e."createdAt" <= ${toTs.toISOString()}::timestamptz
        GROUP BY day
        ORDER BY day
      `;

      const activityAgg = await prismaBase.$queryRaw<{
        day: Date;
        count: bigint;
        toStageIds: (string | null)[];
        pipelineIds: (string | null)[];
      }[]>`
        SELECT
          date_trunc('day', e."occurredAt")::date AS day,
          COUNT(*) AS count,
          array_agg(DISTINCT e."toStageId") AS "toStageIds",
          array_agg(DISTINCT e."pipelineId") AS "pipelineIds"
        FROM activity_events e
        WHERE e."organizationId" = ${currentOrgId}
          AND e.type = ${type}
          AND e."entityType" = 'DEAL'
          AND e."occurredAt" >= ${fromTs.toISOString()}::timestamptz
          AND e."occurredAt" <= ${toTs.toISOString()}::timestamptz
        GROUP BY day
        ORDER BY day
      `;

      const days = new Set<string>();
      dealAgg.forEach((r) => days.add(r.day.toISOString().slice(0, 10)));
      activityAgg.forEach((r) => days.add(r.day.toISOString().slice(0, 10)));

      for (const dayStr of Array.from(days).sort()) {
        const dealRow = dealAgg.find((r) => r.day.toISOString().slice(0, 10) === dayStr);
        const actRow = activityAgg.find((r) => r.day.toISOString().slice(0, 10) === dayStr);
        rows.push({
          orgId: currentOrgId,
          day: new Date(dayStr),
          type,
          dealCount: Number(dealRow?.count ?? 0),
          activityCount: Number(actRow?.count ?? 0),
          dealStageIds: dealRow?.stageIds ?? [],
          activityToStageIds: actRow?.toStageIds ?? [],
          dealPipelineIds: dealRow?.pipelineIds ?? [],
          activityPipelineIds: actRow?.pipelineIds ?? [],
        });
      }
    }
  }

  // Filtrar apenas divergentes
  const divergent = rows.filter((r) => {
    if (r.dealCount !== r.activityCount) return true;
    if (!setEqual(r.dealStageIds, r.activityToStageIds)) return true;
    if (!setEqual(r.dealPipelineIds, r.activityPipelineIds)) return true;
    return false;
  });

  // Amostras de dealIds para cada divergencia
  const samples: Record<string, string[]> = {};
  if (sampleSize > 0) {
    for (const r of divergent) {
      if (r.dealCount > r.activityCount) {
        const key = `${r.orgId}:${r.day.toISOString().slice(0, 10)}:${r.type}:deal>activity`;
        samples[key] = await sampleDealIdsOnlyInDealEvents(
          prismaBase,
          r.orgId,
          r.day,
          r.type,
          sampleSize,
        );
      } else if (r.activityCount > r.dealCount) {
        const key = `${r.orgId}:${r.day.toISOString().slice(0, 10)}:${r.type}:activity>deal`;
        samples[key] = await sampleDealIdsOnlyInActivityEvents(
          prismaBase,
          r.orgId,
          r.day,
          r.type,
          sampleSize,
        );
      }
    }
  }

  const output = format === "csv" ? toCsv(divergent, samples) : toMarkdown(divergent, samples);
  if (outputPath) {
    writeFileSync(outputPath, output, "utf8");
    console.log(`Report written to ${outputPath}`);
  } else {
    console.log(output);
  }

  if (divergent.length === 0) {
    console.log("\nNo divergences found in the requested window.");
  }

  await prismaBase.$disconnect();
}

function setEqual(a: (string | null)[], b: (string | null)[]): boolean {
  const sa = new Set(a.filter((x) => x != null));
  const sb = new Set(b.filter((x) => x != null));
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

async function sampleDealIdsOnlyInDealEvents(
  prisma: PrismaClient,
  orgId: string,
  day: Date,
  type: string,
  limit: number,
): Promise<string[]> {
  const from = day.toISOString();
  const to = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
  const rows = await prisma.$queryRaw<{ dealId: string }[]>`
    SELECT e."dealId"
    FROM deal_events e
    WHERE e."organizationId" = ${orgId}
      AND e.type = ${type}
      AND e."createdAt" >= ${from}::timestamptz
      AND e."createdAt" <= ${to}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM activity_events a
        WHERE a."organizationId" = ${orgId}
          AND a."dealId" = e."dealId"
          AND a.type = ${type}
          AND a."entityType" = 'DEAL'
          AND a."occurredAt" >= ${from}::timestamptz
          AND a."occurredAt" <= ${to}::timestamptz
      )
    LIMIT ${limit}
  `;
  return rows.map((r) => r.dealId);
}

async function sampleDealIdsOnlyInActivityEvents(
  prisma: PrismaClient,
  orgId: string,
  day: Date,
  type: string,
  limit: number,
): Promise<string[]> {
  const from = day.toISOString();
  const to = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
  const rows = await prisma.$queryRaw<{ dealId: string }[]>`
    SELECT e."dealId"
    FROM activity_events e
    WHERE e."organizationId" = ${orgId}
      AND e.type = ${type}
      AND e."entityType" = 'DEAL'
      AND e."occurredAt" >= ${from}::timestamptz
      AND e."occurredAt" <= ${to}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM deal_events a
        WHERE a."organizationId" = ${orgId}
          AND a."dealId" = e."dealId"
          AND a.type = ${type}
          AND a."createdAt" >= ${from}::timestamptz
          AND a."createdAt" <= ${to}::timestamptz
      )
    LIMIT ${limit}
  `;
  return rows.map((r) => r.dealId);
}

function toMarkdown(rows: RowCounts[], samples: Record<string, string[]>): string {
  if (rows.length === 0) return "**No divergences found.**";
  const header = "| orgId | day | type | deal_count | activity_count | diff | deal_stageIds | activity_toStageIds | deal_pipelineIds | activity_pipelineIds | sample_keys |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .map((r) => {
      const diff = r.dealCount - r.activityCount;
      const sampleKeys = Object.keys(samples).filter((k) => k.startsWith(`${r.orgId}:${r.day.toISOString().slice(0, 10)}:${r.type}:`));
      return [
        r.orgId,
        r.day.toISOString().slice(0, 10),
        r.type,
        r.dealCount,
        r.activityCount,
        diff > 0 ? `+${diff} deal` : diff < 0 ? `${diff} activity` : "0",
        prettySet(r.dealStageIds),
        prettySet(r.activityToStageIds),
        prettySet(r.dealPipelineIds),
        prettySet(r.activityPipelineIds),
        sampleKeys.join(", ") || "-",
      ].join(" | ");
    })
    .join("\n");
  return [header, sep, body].join("\n");
}

function toCsv(rows: RowCounts[], samples: Record<string, string[]>): string {
  if (rows.length === 0) return "orgId,day,type,deal_count,activity_count,diff,deal_stageIds,activity_toStageIds,deal_pipelineIds,activity_pipelineIds,sample_keys\n";
  const header = "orgId,day,type,deal_count,activity_count,diff,deal_stageIds,activity_toStageIds,deal_pipelineIds,activity_pipelineIds,sample_keys";
  const body = rows
    .map((r) => {
      const diff = r.dealCount - r.activityCount;
      const sampleKeys = Object.keys(samples).filter((k) => k.startsWith(`${r.orgId}:${r.day.toISOString().slice(0, 10)}:${r.type}:`));
      return [
        r.orgId,
        r.day.toISOString().slice(0, 10),
        r.type,
        r.dealCount,
        r.activityCount,
        diff,
        prettySet(r.dealStageIds),
        prettySet(r.activityToStageIds),
        prettySet(r.dealPipelineIds),
        prettySet(r.activityPipelineIds),
        sampleKeys.join(";"),
      ].join(",");
    })
    .join("\n");
  return [header, body].join("\n");
}

function prettySet(arr: (string | null)[]): string {
  const s = Array.from(new Set(arr.filter((x) => x != null)));
  return s.length ? s.join(",") : "∅";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
