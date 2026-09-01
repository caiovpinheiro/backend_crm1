import { getLogger } from "@/lib/logger";
import type { DistributionDrainPayload } from "@/lib/distribution-drain-queue";
import { withSystemContext } from "@/lib/webhook-context";
import { processPendingDistributionQueue } from "@/services/distribution/pending";

const log = getLogger("jobs.distribution.process-pending");

/**
 * Consome `distribution-drain`. Corre no `worker-distribution` e, na
 * Phase A, também no `worker-leads` (mesmo Redis + `withSystemContext`).
 */
export async function processDistributionDrainJob(
  payload: DistributionDrainPayload,
): Promise<void> {
  const { organizationId, trigger, userId } = payload;
  const ctx = log.child({
    organizationId,
    trigger,
    userId: userId ?? null,
  });
  ctx.info("drain job start");
  const result = await withSystemContext(
    organizationId,
    () => processPendingDistributionQueue({ trigger, userId }),
    {
      actor: {
        type: "SYSTEM",
        label: "Distribuição Inteligente",
        sublabel: `queue:${trigger}`,
      },
    },
  );
  ctx.info(
    {
      resolved: result.resolved,
      cancelled: result.cancelled,
      pending: result.pending,
      skipReason: result.skipReason ?? null,
    },
    "drain job done",
  );
}
