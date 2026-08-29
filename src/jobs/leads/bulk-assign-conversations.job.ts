import type { Job } from "bullmq";

import { invalidateInboxTabCounts } from "@/lib/cache/keys";
import { getLogger } from "@/lib/logger";
import type { BulkAssignConversationsPayload } from "@/lib/queue";
import { sseBus } from "@/lib/sse-bus";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/services/activity-log";
import { assignConversationAssignedTo } from "@/services/conversations";
import { createDealEvent } from "@/services/deals";
import { cancelAiReplyDebounce } from "@/services/ai/inbound-debounce";

import {
  type BulkOperationErrorEntry,
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  truncateErrorMessage,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-assign-conversations");
const CHUNK_SIZE = 25;

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

  const actorId = initiatedByUserId ?? "system";
  await markOperationStarted(operationId, organizationId);

  for (let i = 0; i < conversationIds.length; i += CHUNK_SIZE) {
    const chunkIds = conversationIds.slice(i, i + CHUNK_SIZE);
    let chunkSucceeded = 0;
    let chunkFailed = 0;
    const chunkErrors: BulkOperationErrorEntry[] = [];

    for (const conversationId of chunkIds) {
      try {
        const prev = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: {
            assignedToId: true,
            contactId: true,
            externalId: true,
            assignedTo: { select: { id: true, name: true } },
          },
        });
        const result = await assignConversationAssignedTo(
          conversationId,
          assignedToId,
          {
            id: actorId,
            role: actorRole,
            canReassignOthers,
            canTransfer,
          },
        );
        if (!result.ok) {
          chunkFailed += 1;
          chunkErrors.push({
            itemId: conversationId,
            message:
              result.code === "FORBIDDEN"
                ? "Sem permissão para esta atribuição"
                : result.code === "USER_NOT_FOUND"
                  ? "Usuário não encontrado"
                  : "Conversa não encontrada",
            attempt: job.attemptsMade + 1,
            at: new Date().toISOString(),
          });
          continue;
        }

        chunkSucceeded += 1;
        const nextId = result.conversation.assignedToId ?? null;
        if ((prev?.assignedToId ?? null) !== nextId) {
          cancelAiReplyDebounce(conversationId, "assignee_changed");
          const fromName = prev?.assignedTo?.name ?? null;
          const toName = result.conversation.assignedTo?.name ?? null;
          if (prev?.contactId) {
            const deals = await prisma.deal.findMany({
              where: { contactId: prev.contactId, status: "OPEN" },
              select: { id: true },
            });
            await Promise.all(
              deals.map((d) =>
                createDealEvent(d.id, actorId, "ASSIGNEE_CHANGED", {
                  conversationId,
                  from: prev.assignedToId
                    ? { id: prev.assignedToId, name: fromName }
                    : null,
                  to: nextId ? { id: nextId, name: toName } : null,
                }).catch(() => undefined),
              ),
            );
          }
          await logEvent({
            type: "ASSIGNEE_CHANGED",
            entityType: "CONVERSATION",
            entityId: conversationId,
            entityLabel: result.conversation.externalId ?? null,
            conversationId,
            contactId: result.conversation.contactId ?? null,
            field: "assignedTo",
            oldValue: fromName,
            newValue: toName,
            meta: {
              fromUserId: prev?.assignedToId ?? null,
              toUserId: nextId,
              source: "bulk-async",
            },
          }).catch(() => undefined);
          try {
            sseBus.publish("conversation_updated", {
              organizationId,
              conversationId,
            });
            sseBus.publish("conversation_timeline_updated", {
              organizationId,
              conversationId,
              type: "ASSIGNEE_CHANGED",
            });
          } catch {
            /* best-effort */
          }
        }
      } catch (err) {
        chunkFailed += 1;
        chunkErrors.push({
          itemId: conversationId,
          message: truncateErrorMessage(err),
          attempt: job.attemptsMade + 1,
          at: new Date().toISOString(),
        });
      }
    }

    await incrementOperationProgress(
      operationId,
      organizationId,
      {
        processed: chunkIds.length,
        succeeded: chunkSucceeded,
        failed: chunkFailed,
      },
      chunkErrors.length > 0 ? chunkErrors : undefined,
    );
    await invalidateInboxTabCounts(organizationId);
  }

  await markOperationFinished(operationId, organizationId);
  ctx.info("bulk-assign-conversations finalizado");
}
