import type { Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  assignDealOwner,
  createDealEventsMany,
  type DealEventInput,
} from "@/services/deals";
import type { BulkChangeOwnerPayload } from "@/lib/queue";

import {
  type BulkOperationErrorEntry,
  incrementOperationProgress,
  isOperationCancelled,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  truncateErrorMessage,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-change-owner");

const CHUNK_SIZE = 50;

/**
 * Handler do job `bulk-change-owner` da fila `leads-bulk`.
 *
 * Antes rodava síncrono na rota `POST /api/deals/bulk`: um
 * `assignDealOwner` (transação + propagação para contato/conversas +
 * invalidação do board) por deal, em série, segurando a requisição por
 * vários segundos no processo da API.
 *
 * Por deal continua sendo `assignDealOwner` — a propagação do
 * responsável para contato e chat (regra de responsável único) vive lá
 * e não tem versão em lote. Idempotente: deal que já está com o
 * responsável alvo conta como sucesso sem evento nem gatilho.
 */
export async function processBulkChangeOwner(
  payload: BulkChangeOwnerPayload,
  job: Job<BulkChangeOwnerPayload>,
): Promise<void> {
  const { operationId, organizationId, dealIds, ownerId, initiatedByUserId } = payload;
  const ctx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    ownerId,
    dealCount: dealIds.length,
  });
  ctx.info("Iniciando bulk-change-owner");

  if (dealIds.length === 0) {
    await markOperationFailed(operationId, organizationId, "dealIds vazio");
    return;
  }

  await markOperationStarted(operationId, organizationId);

  const ownerName = ownerId
    ? (await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } }))
        ?.name ?? ownerId
    : null;

  for (let i = 0; i < dealIds.length; i += CHUNK_SIZE) {
    if (await isOperationCancelled(operationId, organizationId)) {
      ctx.info("Operação cancelada — interrompendo chunks restantes");
      return;
    }
    const chunkIds = dealIds.slice(i, i + CHUNK_SIZE);
    const chunkErrors: BulkOperationErrorEntry[] = [];
    let chunkSucceeded = 0;
    const events: DealEventInput[] = [];

    const deals = await prisma.deal.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true, ownerId: true, owner: { select: { name: true } } },
    });
    const found = new Set(deals.map((d) => d.id));
    for (const dealId of chunkIds) {
      if (found.has(dealId)) continue;
      chunkErrors.push({
        itemId: dealId,
        message: "Deal não encontrado ou não pertence à organização",
        attempt: job.attemptsMade + 1,
        at: new Date().toISOString(),
      });
    }

    for (const deal of deals) {
      if (deal.ownerId === ownerId) {
        chunkSucceeded++;
        continue;
      }
      try {
        await assignDealOwner(deal.id, ownerId);
        events.push({
          dealId: deal.id,
          userId: initiatedByUserId,
          type: "OWNER_CHANGED",
          meta: {
            from: deal.ownerId ? { id: deal.ownerId, name: deal.owner?.name ?? "" } : null,
            to: ownerId ? { id: ownerId, name: ownerName } : null,
          },
        });
        chunkSucceeded++;
      } catch (err) {
        chunkErrors.push({
          itemId: deal.id,
          message: truncateErrorMessage(err),
          attempt: job.attemptsMade + 1,
          at: new Date().toISOString(),
        });
      }
    }

    await createDealEventsMany(events).catch((err: unknown) => {
      ctx.warn({ err: truncateErrorMessage(err) }, "createDealEventsMany falhou (best-effort)");
    });

    await incrementOperationProgress(
      operationId,
      organizationId,
      {
        processed: chunkIds.length,
        succeeded: chunkSucceeded,
        failed: chunkErrors.length,
      },
      chunkErrors.length > 0 ? chunkErrors : undefined,
    );
  }

  await markOperationFinished(operationId, organizationId);
  ctx.info("bulk-change-owner finalizado");
}
