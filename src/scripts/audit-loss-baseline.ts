/**
 * Baseline de perda entre deal_events e activity_events.
 *
 * Apenas contagens por org/dia/tipo — nao usa colunas normalizadas novas.
 * Usar quando as migrations de dimensoes ainda nao foram aplicadas.
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const fromDate = argValue("from");
const toDate = argValue("to");
const orgId = argValue("org");

if (!fromDate || !toDate || !orgId) {
  console.error("Usage: --org=<id> --from=YYYY-MM-DD --to=YYYY-MM-DD");
  process.exit(1);
}

const fromTs = new Date(fromDate);
const toTs = new Date(`${toDate}T23:59:59.999Z`);

async function main() {
  const { prismaBase } = await import("@/lib/prisma-base");

  const rows = await prismaBase.$queryRaw<{
    day: Date;
    type: string;
    deal_count: bigint;
    activity_count: bigint;
  }[]>`
    SELECT
      COALESCE(d.day, a.day) AS day,
      COALESCE(d.type, a.type) AS type,
      COALESCE(d.count, 0) AS deal_count,
      COALESCE(a.count, 0) AS activity_count
    FROM (
      SELECT date_trunc('day', "createdAt")::date AS day, type, COUNT(*) AS count
      FROM deal_events
      WHERE "organizationId" = ${orgId}
        AND type IN ('CREATED', 'STAGE_CHANGED')
        AND "createdAt" >= ${fromTs.toISOString()}::timestamptz
        AND "createdAt" <= ${toTs.toISOString()}::timestamptz
      GROUP BY day, type
    ) d
    FULL OUTER JOIN (
      SELECT date_trunc('day', "occurredAt")::date AS day, type, COUNT(*) AS count
      FROM activity_events
      WHERE "organizationId" = ${orgId}
        AND type IN ('CREATED', 'STAGE_CHANGED')
        AND "entityType" = 'DEAL'
        AND "occurredAt" >= ${fromTs.toISOString()}::timestamptz
        AND "occurredAt" <= ${toTs.toISOString()}::timestamptz
      GROUP BY day, type
    ) a ON d.day = a.day AND d.type = a.type
    ORDER BY day, type
  `;

  if (rows.length === 0) {
    console.log("No CREATED/STAGE_CHANGED events in the requested window.");
    await prismaBase.$disconnect();
    return;
  }

  console.log("| day | type | deal_events | activity_events | diff | diff% |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const r of rows) {
    const diff = Number(r.deal_count) - Number(r.activity_count);
    const pct = r.deal_count > 0
      ? ((diff / Number(r.deal_count)) * 100).toFixed(2)
      : r.activity_count > 0 ? "-100.00" : "0.00";
    console.log(
      `| ${r.day.toISOString().slice(0, 10)} | ${r.type} | ${r.deal_count} | ${r.activity_count} | ${diff >= 0 ? `+${diff}` : diff} | ${pct}% |`,
    );
  }

  await prismaBase.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
