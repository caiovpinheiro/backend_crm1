import { metrics } from "@/lib/metrics";
import { prismaBase } from "@/lib/prisma-base";

export async function collectActivityOutboxMetrics(): Promise<void> {
  const rows = await prismaBase.$queryRaw<
    {
      organizationId: string;
      pending: bigint;
      oldestSeconds: number | null;
      dead: bigint;
    }[]
  >`
    SELECT
      "organizationId",
      COUNT(*) FILTER (WHERE "processedAt" IS NULL AND "deadLetterAt" IS NULL)::bigint AS pending,
      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("createdAt"))) FILTER (WHERE "processedAt" IS NULL AND "deadLetterAt" IS NULL) AS "oldestSeconds",
      COUNT(*) FILTER (WHERE "deadLetterAt" IS NOT NULL)::bigint AS dead
    FROM "activity_outbox"
    GROUP BY "organizationId"
  `;

  for (const r of rows) {
    const org = r.organizationId || "unknown";
    metrics.activityOutbox.depth.set({ organization: org }, Number(r.pending));
    metrics.activityOutbox.dead.set({ organization: org }, Number(r.dead));
    metrics.activityOutbox.age.set(
      { organization: org },
      r.oldestSeconds ?? 0,
    );
  }
}
