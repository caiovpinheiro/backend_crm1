import type { Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { invalidateInboxTabCounts } from "@/lib/cache/keys";
import type { BulkResolveConversationsPayload } from "@/lib/queue";
import { resolveConversationsInline } from "@/services/conversations";

import {
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  incrementOperationProgress,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-resolve-conversations");

/**
 * Handler do job `bulk-resolve-conversations` da fila `leads-bulk`.
 *
 * A rota produtora (`POST /api/conversations/bulk`) já aplicou visibilidade
 * e tabulação. O close em si é o mesmo `resolveConversationsInline` da API
 * (updateMany + eventos) — um só caminho de persistência.
 */
export async function processBulkResolveConversations(
  payload: BulkResolveConversationsPayload,
  job: Job<BulkResolveConversationsPayload>,
): Promise<void> {
  const {
    operationId,
    organizationId,
    conversationIds,
    keepAgent,
    keepDepartment,
    tabulationId,
    tabulationDepartmentId,
    tabulationName,
    tabulationNumber,
    tabulationAncestorIds,
    skipAutomations,
  } = payload;
  const ctx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    conversationCount: conversationIds.length,
  });
  ctx.info("Iniciando bulk-resolve-conversations");

  if (conversationIds.length === 0) {
    await markOperationFailed(operationId, organizationId, "conversationIds vazio");
    ctx.warn("Payload vazio — operação marcada como FAILED");
    return;
  }

  await markOperationStarted(operationId, organizationId);

  const tabulation =
    tabulationId &&
    tabulationDepartmentId &&
    tabulationName != null &&
    tabulationNumber != null
      ? {
          tabulationId,
          departmentId: tabulationDepartmentId,
          name: tabulationName,
          number: tabulationNumber,
          ancestorIds: tabulationAncestorIds ?? [],
        }
      : null;

  const { updated, missing } = await resolveConversationsInline({
    ids: conversationIds,
    keepAgent,
    keepDepartment,
    tabulation,
    skipAutomations,
  });

  const alreadyResolved = Math.max(
    0,
    conversationIds.length - updated - missing,
  );
  await incrementOperationProgress(operationId, organizationId, {
    processed: conversationIds.length,
    succeeded: updated + alreadyResolved,
    failed: missing,
  });
  await invalidateInboxTabCounts(organizationId);
  await markOperationFinished(operationId, organizationId);
  ctx.info(
    { updated, missing, alreadyResolved },
    "bulk-resolve-conversations finalizado",
  );
}
