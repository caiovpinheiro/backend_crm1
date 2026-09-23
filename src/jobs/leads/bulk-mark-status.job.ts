import type { Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { fireTrigger, notifyDealStageChanged } from "@/services/automation-triggers";
import {
  createDealEventsMany,
  markDealLost,
  markDealWon,
  type DealEventInput,
} from "@/services/deals";
import type { BulkMarkStatusPayload } from "@/lib/queue";

import { runWithConcurrency } from "./_concurrency";
import {
  type BulkOperationErrorEntry,
  incrementOperationProgress,
  isOperationCancelled,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  truncateErrorMessage,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-mark-status");

const CHUNK_SIZE = 50;
const SIDE_EFFECT_CONCURRENCY = 3;

/**
 * Handler do job `bulk-mark-status` (ações `mark_won` / `mark_lost` do
 * board) da fila `leads-bulk`.
 *
 * Antes rodava síncrono na rota `POST /api/deals/bulk`, um
 * `markDealWon`/`markDealLost` por deal em série dentro da requisição.
 *
 * Por deal continua sendo `markDealWon`/`markDealLost`: movem para o
 * estágio terminal do funil do deal e disparam fulfillment. Idempotente:
 * deal que já está no status alvo conta como sucesso, sem evento nem
 * gatilho. O motivo da perda já foi validado na rota antes de enfileirar.
 */
export async function processBulkMarkStatus(
  payload: BulkMarkStatusPayload,
  job: Job<BulkMarkStatusPayload>,
): Promise<void> {
  const { operationId, organizationId, dealIds, status, lostReason, initiatedByUserId } = payload;
  const ctx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    status,
    dealCount: dealIds.length,
  });
  ctx.info("Iniciando bulk-mark-status");

  if (dealIds.length === 0) {
    await markOperationFailed(operationId, organizationId, "dealIds vazio");
    return;
  }

  await markOperationStarted(operationId, organizationId);

  for (let i = 0; i < dealIds.length; i += CHUNK_SIZE) {
    if (await isOperationCancelled(operationId, organizationId)) {
      ctx.info("Operação cancelada — interrompendo chunks restantes");
      return;
    }
    const chunkIds = dealIds.slice(i, i + CHUNK_SIZE);
    const chunkErrors: BulkOperationErrorEntry[] = [];
    let chunkSucceeded = 0;
    const events: DealEventInput[] = [];
    const triggers: (() => Promise<void>)[] = [];

    const deals = await prisma.deal.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true, status: true, stageId: true },
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
      if (deal.status === status) {
        chunkSucceeded++;
        continue;
      }
      try {
        const updated =
          status === "WON"
            ? await markDealWon(deal.id)
            : await markDealLost(deal.id, lostReason ?? null);
        events.push({
          dealId: deal.id,
          userId: initiatedByUserId,
          type: "STATUS_CHANGED",
          meta:
            status === "LOST"
              ? { from: deal.status, to: "LOST", lostReason: lostReason ?? "" }
              : { from: deal.status, to: "WON" },
        });
        triggers.push(() =>
          fireTrigger(status === "WON" ? "deal_won" : "deal_lost", {
            dealId: deal.id,
            data:
              status === "LOST"
                ? { fromStatus: deal.status, lostReason: lostReason ?? "" }
                : { fromStatus: deal.status },
          }).catch((err: unknown) => {
            ctx.warn(
              { dealId: deal.id, err: truncateErrorMessage(err) },
              "fireTrigger falhou (fire-and-forget)",
            );
          }),
        );
        // Ganho/Perdido move para o estágio terminal — dispara também
        // "mudança de fase" pra automações "quando entra na fase X".
        triggers.push(() =>
          notifyDealStageChanged(deal.id, deal.stageId, updated.stageId).catch(() => {}),
        );
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
    await runWithConcurrency(triggers, SIDE_EFFECT_CONCURRENCY);

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
  ctx.info("bulk-mark-status finalizado");
}
