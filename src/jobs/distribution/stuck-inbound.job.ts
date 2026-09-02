import { getLogger } from "@/lib/logger";
import type { DistributionStuckInboundPayload } from "@/lib/distribution-execute-queue";
import { distributeStuckInbound } from "@/services/ai/stuck-inbound-distribution";

const log = getLogger("jobs.distribution.stuck-inbound");

/**
 * Consome `distribution-execute` / `stuck-inbound`.
 * `distributeStuckInbound` já faz `withSystemContext` por org.
 */
export async function processDistributionStuckInboundJob(
  payload: DistributionStuckInboundPayload,
): Promise<void> {
  const ctx = log.child({
    organizationId: payload.organizationId ?? null,
    stuckMs: payload.stuckMs ?? null,
  });
  ctx.info("stuck-inbound job start");
  const result = await distributeStuckInbound({
    apply: payload.apply ?? true,
    stuckMs: payload.stuckMs,
    sinceMs: payload.sinceMs,
    limit: payload.limit,
    organizationId: payload.organizationId ?? null,
  });
  ctx.info(
    {
      candidates: result.candidates,
      distributed: result.distributed,
      queued: result.queued,
      failed: result.failed,
    },
    "stuck-inbound job done",
  );
}
