import type { Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { invalidateInboxTabCounts } from "@/lib/cache/keys";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { tabulationLogMeta } from "@/services/tabulations";
import type { BulkResolveConversationsPayload } from "@/lib/queue";

import {
  type BulkOperationErrorEntry,
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  truncateErrorMessage,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-resolve-conversations");

/**
 * Tamanho do chunk: 50 conversas. Cada chunk:
 *   1. Lê o estado atual (status) das conversas do chunk.
 *   2. `updateMany` para RESOLVED apenas nas que ainda não estão resolvidas.
 *   3. Emite ActivityLog CONVERSATION_CLOSED fire-and-forget por conversa alterada.
 *
 * Idempotência: conversa já RESOLVED conta como sucesso (noop) sem re-logar —
 * retries do BullMQ não duplicam eventos nem reencerram.
 */
const CHUNK_SIZE = 50;

/**
 * Handler do job `bulk-resolve-conversations` da fila `leads-bulk`.
 *
 * A rota produtora (`POST /api/conversations/bulk`) já:
 *   - aplicou o filtro de visibilidade do usuário nos ids;
 *   - validou a tabulação (folha da org); com folha, o lote já inclui
 *     todas as selecionadas (a mesma tabulação fecha o lote inteiro);
 *   - leu as org settings keepAgent/keepDepartment.
 * Aqui confiamos no payload saneado — não relemos settings (evita acesso a
 * org-settings fora de RequestContext no worker).
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

  for (let i = 0; i < conversationIds.length; i += CHUNK_SIZE) {
    const chunkIds = conversationIds.slice(i, i + CHUNK_SIZE);
    const chunkLog = ctx.child({
      chunkIndex: Math.floor(i / CHUNK_SIZE),
      chunkSize: chunkIds.length,
    });

    let chunkErrors: BulkOperationErrorEntry[] = [];
    let chunkSucceeded = 0;
    let chunkFailed = 0;

    try {
      const convs = await prisma.conversation.findMany({
        where: { id: { in: chunkIds } },
        select: {
          id: true,
          status: true,
          contactId: true,
          departmentId: true,
          assignedToId: true,
          assignedTo: { select: { name: true } },
          contact: { select: { name: true } },
        },
      });

      const found = new Set(convs.map((c) => c.id));
      const missing = chunkIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        const now = new Date().toISOString();
        chunkFailed += missing.length;
        chunkErrors.push(
          ...missing.map((conversationId) => ({
            itemId: conversationId,
            message: "Conversa não encontrada ou não pertence à organização",
            attempt: job.attemptsMade + 1,
            at: now,
          })),
        );
      }

      const toResolve = convs.filter((c) => c.status !== "RESOLVED");
      const noOps = convs.filter((c) => c.status === "RESOLVED");
      chunkSucceeded += noOps.length; // já encerrada = sucesso idempotente.

      if (toResolve.length > 0) {
        const closePatch = {
          status: "RESOLVED" as const,
          closedAt: new Date(),
          hasError: false,
          ...(keepAgent ? {} : { assignedToId: null }),
          ...(keepDepartment ? {} : { departmentId: null }),
        };
        const applyTab = Boolean(tabulationId);
        await prisma.conversation.updateMany({
          where: {
            id: { in: toResolve.map((c) => c.id) },
            status: { not: "RESOLVED" },
          },
          data: applyTab ? { ...closePatch, tabulationId } : closePatch,
        });
        const tabulatedIds = new Set(
          applyTab ? toResolve.map((c) => c.id) : [],
        );
        chunkSucceeded += toResolve.length;

        const { sseBus } = await import("@/lib/sse-bus");
        for (const conv of toResolve) {
          try {
            sseBus.publish("conversation_updated", {
              organizationId,
              conversationId: conv.id,
            });
          } catch {
            /* best-effort */
          }
        }

        // Sem "manter atendente": o updateMany acima zerou assignedToId —
        // limpa também deal aberto + contato desses responsáveis (mesma
        // regra do encerramento manual em updateConversationStatusInDb).
        if (!keepAgent) {
          const pairs = new Map<string, { contactId: string; userId: string }>();
          for (const conv of toResolve) {
            if (conv.contactId && conv.assignedToId) {
              pairs.set(`${conv.contactId}:${conv.assignedToId}`, {
                contactId: conv.contactId,
                userId: conv.assignedToId,
              });
            }
          }
          if (pairs.size > 0) {
            const { clearContactOwnershipOnClose } = await import("@/services/deals");
            for (const { contactId, userId } of pairs.values()) {
              await clearContactOwnershipOnClose({
                contactId,
                clearedUserId: userId,
                actorUserId: payload.initiatedByUserId ?? null,
              }).catch((err: unknown) => {
                chunkLog.warn(
                  { contactId, clearedUserId: userId, err: truncateErrorMessage(err) },
                  "clearContactOwnershipOnClose falhou (fire-and-forget)",
                );
              });
            }
          }
        }

        for (const conv of toResolve) {
          // Espelha a remoção do atendente no chat/timeline (mesmo evento
          // do encerramento manual) quando a org não mantém o atendente.
          if (!keepAgent && conv.assignedToId) {
            logEvent({
              type: "ASSIGNEE_CHANGED",
              entityType: "CONVERSATION",
              entityId: conv.id,
              entityLabel: conv.contact?.name ?? null,
              conversationId: conv.id,
              contactId: conv.contactId,
              field: "assignedTo",
              oldValue: conv.assignedTo?.name ?? null,
              newValue: null,
              meta: {
                fromUserId: conv.assignedToId,
                toUserId: null,
                reason: "conversation_closed",
                source: "bulk-async",
              },
            }).catch(() => {});
          }
          const appliedTabulation = tabulatedIds.has(conv.id)
            ? tabulationId
            : null;
          logEvent({
            type: "CONVERSATION_CLOSED",
            entityType: "CONVERSATION",
            entityId: conv.id,
            entityLabel: conv.contact?.name ?? null,
            conversationId: conv.id,
            contactId: conv.contactId,
            field: "status",
            oldValue: conv.status,
            newValue: "RESOLVED",
            meta: {
              from: conv.status,
              to: "RESOLVED",
              source: "bulk-async",
              ...(appliedTabulation ? { tabulationId: appliedTabulation } : {}),
              ...(skipAutomations ? { skipAutomations: true } : {}),
            },
          }).catch((err: unknown) => {
            chunkLog.warn(
              { conversationId: conv.id, err: truncateErrorMessage(err) },
              "logEvent CONVERSATION_CLOSED falhou (fire-and-forget)",
            );
          });

          if (
            appliedTabulation &&
            tabulationName != null &&
            tabulationNumber != null
          ) {
            logEvent({
              type: "CONVERSATION_TABULATED",
              entityType: "CONVERSATION",
              entityId: conv.id,
              entityLabel: conv.contact?.name ?? null,
              conversationId: conv.id,
              contactId: conv.contactId,
              meta: tabulationLogMeta(
                {
                  tabulationId: appliedTabulation,
                  ancestorIds: tabulationAncestorIds ?? [],
                  departmentId: tabulationDepartmentId,
                  name: tabulationName,
                  number: tabulationNumber,
                },
                { source: "bulk-async" },
              ),
            }).catch((err: unknown) => {
              chunkLog.warn(
                { conversationId: conv.id, err: truncateErrorMessage(err) },
                "logEvent CONVERSATION_TABULATED falhou (fire-and-forget)",
              );
            });
          }

          if (!skipAutomations) {
            void (async () => {
              let dealId: string | undefined;
              if (conv.contactId) {
                const deal = await prisma.deal.findFirst({
                  where: { contactId: conv.contactId, status: "OPEN" },
                  orderBy: { createdAt: "desc" },
                  select: { id: true },
                });
                dealId = deal?.id;
              }
              await fireTrigger("conversation_tabulated", {
                contactId: conv.contactId ?? undefined,
                dealId,
                data: {
                  tabulationId: appliedTabulation,
                  ancestorIds: appliedTabulation
                    ? (tabulationAncestorIds ?? [])
                    : [],
                  departmentId:
                    conv.departmentId ?? tabulationDepartmentId ?? null,
                  conversationId: conv.id,
                },
              });
            })().catch((err: unknown) => {
              chunkLog.warn(
                { conversationId: conv.id, err: truncateErrorMessage(err) },
                "fireTrigger conversation_tabulated falhou (fire-and-forget)",
              );
            });
          }
        }
      }

      chunkLog.info(
        { resolved: toResolve.length, noOps: noOps.length, missing: missing.length },
        "Chunk processado",
      );
    } catch (err) {
      chunkFailed += chunkIds.length - chunkSucceeded - chunkErrors.length;
      const errMsg = truncateErrorMessage(err);
      const now = new Date().toISOString();
      chunkErrors = chunkErrors.concat(
        chunkIds
          .filter((id) => !chunkErrors.some((e) => e.itemId === id))
          .map((conversationId) => ({
            itemId: conversationId,
            message: errMsg,
            attempt: job.attemptsMade + 1,
            at: now,
          })),
      );
      chunkLog.error({ err }, "Chunk falhou — itens marcados como erro");
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
  await invalidateInboxTabCounts(organizationId);
  ctx.info("bulk-resolve-conversations finalizado");
}
