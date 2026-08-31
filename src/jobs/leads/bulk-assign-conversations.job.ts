import type { Job } from "bullmq";

import { invalidateInboxTabCounts } from "@/lib/cache/keys";
import { getLogger } from "@/lib/logger";
import type { BulkAssignConversationsPayload } from "@/lib/queue";
import { assignConversationsInline } from "@/services/conversations";

import {
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-assign-conversations");

/**
 * Handler do job `bulk-assign-conversations` da fila `leads-bulk`.
 *
 * A rota produtora (`POST /api/conversations/bulk`) já aplicou visibilidade
 * e RBAC de rota. O assign em si é o mesmo `assignConversationsInline` da API
 * — um só caminho de persistência.
 */
export async function processBulkAssignConversations(
  payload: BulkAssignConversationsPayload,
  job: Job<BulkAssignConversationsPayload>,
): Promise<void> {
  const {
    operationId,
    organizationId,
    conversationIds,
    assignedToId,
    initiatedByUserId,
    actorRole,
    canReassignOthers,
    canTransfer,
  } = payload;
  const ctx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    conversationCount: conversationIds.length,
  });
  ctx.info("Iniciando bulk-assign-conversations");

  if (conversationIds.length === 0) {
    await markOperationFailed(operationId, organizationId, "conversationIds vazio");
    return;
  }

  await markOperationStarted(operationId, organizationId);

  const { updated, skipped } = await assignConversationsInline({
    ids: conversationIds,
    assignedToId,
    actor: {
      id: initiatedByUserId ?? "system",
      role: actorRole,
      canReassignOthers,
      canTransfer,
    },
    organizationId,
    source: "bulk-async",
  });

  await incrementOperationProgress(operationId, organizationId, {
    processed: conversationIds.length,
    succeeded: updated,
    failed: skipped.length,
  });
  await invalidateInboxTabCounts(organizationId);
  await markOperationFinished(operationId, organizationId);
  ctx.info({ updated, skipped: skipped.length }, "bulk-assign-conversations finalizado");
}
