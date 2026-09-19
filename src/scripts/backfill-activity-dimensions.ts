/**
 * Backfill operacional das dimensoes normalizadas em activity_events.
 *
 * Fora do ciclo de migrations: executavel/reexecutavel, com checkpoint por org.
 * source e reconstruido a partir do contact.source ATUAL — portanto recebe
 * sourceIsReconstructed=true. Eventos novos (logEvent) devem escrever source
 * com sourceIsReconstructed=false (snapshot real no momento do evento).
 *
 * Uso:
 *   pnpm tsx src/scripts/backfill-activity-dimensions.ts --apply
 *   pnpm tsx src/scripts/backfill-activity-dimensions.ts --apply --org=<id>
 *   pnpm tsx src/scripts/backfill-activity-dimensions.ts --apply --entity=source
 *   pnpm tsx src/scripts/backfill-activity-dimensions.ts --batch-size=10000
 */

import { Prisma } from "@prisma/client";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const ENTITY = "activity_event_dimensions";
const DEFAULT_BATCH = 5_000;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const apply = argFlag("apply");
  const orgId = argValue("org");
  const batchSize = Math.max(1, Number(argValue("batch-size") ?? DEFAULT_BATCH));
  const entityFilter = argValue("entity"); // "dimensions" | "source" | null
  const dry = !apply;

  const { prismaBase } = await import("@/lib/prisma-base");

  const orgs = orgId
    ? [orgId]
    : (
        await prismaBase.organization.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((o) => o.id);

  if (dry) {
    console.log(`[backfill-activity-dimensions] DRY-RUN orgs=${orgs.length} batch=${batchSize}`);
  }

  let totalDimensions = 0;
  let totalSource = 0;

  for (const currentOrgId of orgs) {
    if (!entityFilter || entityFilter === "dimensions") {
      const n = await backfillDimensions(prismaBase, currentOrgId, batchSize, apply);
      totalDimensions += n;
      console.log(`[backfill-activity-dimensions] org=${currentOrgId} dimensions=${n}`);
    }
    if (!entityFilter || entityFilter === "source") {
      const n = await backfillSource(prismaBase, currentOrgId, batchSize, apply);
      totalSource += n;
      console.log(`[backfill-activity-dimensions] org=${currentOrgId} source=${n}`);
    }
  }

  console.log(
    `[backfill-activity-dimensions] done apply=${apply} dimensions=${totalDimensions} source=${totalSource}`,
  );
  await prismaBase.$disconnect();
}

async function loadCheckpoint(
  prisma: typeof import("@/lib/prisma-base").prismaBase,
  orgId: string,
  subEntity: string,
) {
  const fullEntity = `${ENTITY}:${subEntity}`;
  const row = await prisma.backfillCheckpoint.findUnique({
    where: { organizationId: orgId },
  });
  if (row && row.entityName === fullEntity) {
    return {
      lastId: row.lastId ?? null,
      lastOccurredAt: row.lastOccurredAt ?? null,
    };
  }
  return { lastId: null, lastOccurredAt: null };
}

async function saveCheckpoint(
  prisma: typeof import("@/lib/prisma-base").prismaBase,
  orgId: string,
  subEntity: string,
  lastId: string | null,
  lastOccurredAt: Date | null,
) {
  const fullEntity = `${ENTITY}:${subEntity}`;
  await prisma.backfillCheckpoint.upsert({
    where: { organizationId: orgId },
    create: {
      organizationId: orgId,
      entityName: fullEntity,
      lastId,
      lastOccurredAt,
    },
    update: {
      entityName: fullEntity,
      lastId,
      lastOccurredAt,
    },
  });
}

async function backfillDimensions(
  prisma: typeof import("@/lib/prisma-base").prismaBase,
  orgId: string,
  batchSize: number,
  apply: boolean,
): Promise<number> {
  let touched = 0;
  let batches = 0;

  for (;;) {
    const checkpoint = await loadCheckpoint(prisma, orgId, "dimensions");
    const cursor = checkpoint.lastOccurredAt
      ? Prisma.sql`AND ("occurredAt", id) > (${checkpoint.lastOccurredAt}, ${checkpoint.lastId ?? ""})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<Array<{ id: string; occurredAt: Date }>>`
      SELECT id, "occurredAt"
      FROM "activity_events"
      WHERE "organizationId" = ${orgId}
        ${cursor}
        AND (
          "meta"->>'pipelineId' IS NOT NULL
          OR "meta"->'to'->>'pipelineId' IS NOT NULL
          OR (type = 'STAGE_CHANGED' AND "meta"->'from'->>'pipelineId' IS NOT NULL)
          OR "meta"->>'fromStageId' IS NOT NULL
          OR "meta"->'from'->>'id' IS NOT NULL
          OR "meta"->>'toStageId' IS NOT NULL
          OR "meta"->'to'->>'id' IS NOT NULL
          OR "meta"->>'stageId' IS NOT NULL
          OR "meta"->>'tabulationId' IS NOT NULL
          OR "meta"->>'departmentId' IS NOT NULL
          OR "meta"->>'tabulationDepartmentId' IS NOT NULL
          OR "meta"->>'channel' IS NOT NULL
        )
        AND (
          "pipelineId" IS NULL
          OR "fromStageId" IS NULL
          OR "toStageId" IS NULL
          OR "tabulationId" IS NULL
          OR "departmentId" IS NULL
          OR "channel" IS NULL
        )
      ORDER BY "occurredAt" ASC, id ASC
      LIMIT ${batchSize}
    `;

    if (rows.length === 0) break;
    batches += 1;

    const ids = rows.map((r) => r.id);
    const idList = Prisma.join(ids);

    if (apply) {
      const n = await prisma.$executeRaw`
        UPDATE "activity_events"
        SET
          "pipelineId" = COALESCE(
            "meta"->>'pipelineId',
            "meta"->'to'->>'pipelineId',
            CASE WHEN type = 'STAGE_CHANGED' THEN "meta"->'from'->>'pipelineId' END
          ),
          "fromStageId" = COALESCE(
            "meta"->>'fromStageId',
            "meta"->'from'->>'id'
          ),
          "toStageId" = COALESCE(
            "meta"->>'toStageId',
            "meta"->'to'->>'id',
            "meta"->>'stageId'
          ),
          "tabulationId" = "meta"->>'tabulationId',
          "departmentId" = COALESCE(
            "meta"->>'departmentId',
            "meta"->>'tabulationDepartmentId'
          ),
          "channel" = "meta"->>'channel'
        WHERE id IN (${idList})
          AND "organizationId" = ${orgId}
      `;
      touched += Number(n);
    } else {
      touched += rows.length;
    }

    const last = rows[rows.length - 1]!;
    if (apply) {
      await saveCheckpoint(prisma, orgId, "dimensions", last.id, last.occurredAt);
    }

    if (rows.length < batchSize) break;
  }

  return touched;
}

async function backfillSource(
  prisma: typeof import("@/lib/prisma-base").prismaBase,
  orgId: string,
  batchSize: number,
  apply: boolean,
): Promise<number> {
  let touched = 0;

  for (;;) {
    const checkpoint = await loadCheckpoint(prisma, orgId, "source");
    const cursor = checkpoint.lastOccurredAt
      ? Prisma.sql`AND ("occurredAt", id) > (${checkpoint.lastOccurredAt}, ${checkpoint.lastId ?? ""})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<Array<{ id: string; occurredAt: Date }>>`
      SELECT id, "occurredAt"
      FROM "activity_events"
      WHERE "organizationId" = ${orgId}
        ${cursor}
        AND "dealId" IS NOT NULL
        AND "source" IS NULL
      ORDER BY "occurredAt" ASC, id ASC
      LIMIT ${batchSize}
    `;

    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const idList = Prisma.join(ids);

    if (apply) {
      const n = await prisma.$executeRaw`
        UPDATE "activity_events" e
        SET
          "source" = c.source,
          "sourceIsReconstructed" = true
        FROM deals d
        JOIN contacts c ON c.id = d."contactId"
        WHERE e.id IN (${idList})
          AND e."organizationId" = ${orgId}
          AND e."dealId" = d.id
          AND d."contactId" = c.id
          AND e."source" IS NULL
      `;
      touched += Number(n);
    } else {
      touched += rows.length;
    }

    const last = rows[rows.length - 1]!;
    if (apply) {
      await saveCheckpoint(prisma, orgId, "source", last.id, last.occurredAt);
    }

    if (rows.length < batchSize) break;
  }

  return touched;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
