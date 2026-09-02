import { getLogger } from "@/lib/logger";
import type { DistributionRedistributePayload } from "@/lib/distribution-execute-queue";
import { withSystemContext } from "@/lib/webhook-context";
import {
  redistributeResponsibleQueue,
  type RedistributeJobOutcome,
} from "@/services/distribution/redistribute";

const log = getLogger("jobs.distribution.redistribute");

/**
 * Consome `distribution-execute` / `redistribute`. Corre no `worker-distribution`.
 */
export async function processDistributionRedistributeJob(
  payload: DistributionRedistributePayload,
): Promise<RedistributeJobOutcome> {
  const { organizationId, sourceUserId, mode } = payload;
  const ctx = log.child({ organizationId, sourceUserId, mode });
  ctx.info("redistribute job start");
  try {
    const result = await withSystemContext(
      organizationId,
      () =>
        redistributeResponsibleQueue({
          sourceUserId,
          mode,
          recipientUserIds: payload.recipientUserIds,
          queueScope: payload.queueScope,
          actor: payload.actor,
        }),
      {
        userId: payload.actor.id,
        actor: {
          type: "SYSTEM",
          label: "Distribuição Inteligente",
          sublabel: `redistribute:${mode}`,
        },
      },
    );
    ctx.info(
      { moved: result.moved, skipped: result.skipped, total: result.total },
      "redistribute job done",
    );
    return { ok: true, result };
  } catch (e) {
    const err = e as { message?: string; code?: string; status?: number };
    const status = typeof err.status === "number" ? err.status : 500;
    if (status < 500) {
      ctx.info({ status, code: err.code ?? null }, "redistribute rejected");
      return {
        ok: false,
        message: err.message ?? "Erro ao redistribuir fila.",
        code: err.code,
        status,
      };
    }
    throw e;
  }
}
