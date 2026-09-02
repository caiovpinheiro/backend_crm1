import { getLogger } from "@/lib/logger";
import type { DistributionExecutePayload } from "@/lib/distribution-execute-queue";
import { withSystemContext } from "@/lib/webhook-context";
import {
  executeDistribution,
  type DistributionResult,
  type DistributionTriggerSource,
} from "@/services/distribution";

const log = getLogger("jobs.distribution.execute");

function actorForTrigger(trigger: DistributionTriggerSource) {
  if (trigger === "AUTOMATION") {
    return {
      type: "AUTOMATION" as const,
      label: "Automação",
      sublabel: "execute_distribution",
    };
  }
  if (trigger === "AI_AGENT") {
    return { type: "AI" as const, label: "Agente IA" };
  }
  return {
    type: "SYSTEM" as const,
    label: "Distribuição Inteligente",
    sublabel: `trigger:${trigger}`,
  };
}

/**
 * Consome `distribution-execute` / `execute`. Corre no `worker-distribution`.
 */
export async function processDistributionExecuteJob(
  payload: DistributionExecutePayload,
): Promise<DistributionResult> {
  const { organizationId, triggerSource, requestedByUserId } = payload;
  const ctx = log.child({
    organizationId,
    triggerSource,
    conversationId: payload.conversationId ?? null,
    correlationId: payload.correlationId ?? null,
  });
  ctx.info("execute job start");
  const result = await withSystemContext(
    organizationId,
    () =>
      executeDistribution({
        dealId: payload.dealId ?? null,
        contactId: payload.contactId ?? null,
        conversationId: payload.conversationId ?? null,
        departmentId: payload.departmentId ?? null,
        departmentIds: payload.departmentIds ?? null,
        reassign: payload.reassign === true,
        allowOrgWideFallback: payload.allowOrgWideFallback === true,
        distributionType: payload.distributionType ?? null,
        triggerSource,
      }),
    {
      userId: requestedByUserId ?? "system",
      actor: actorForTrigger(triggerSource),
    },
  );
  ctx.info(
    {
      success: result.success,
      reason: result.reason,
      selectedUserId: result.selectedUserId,
    },
    "execute job done",
  );
  return result;
}
