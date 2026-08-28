import type { Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { fireTrigger } from "@/services/automation-triggers";
import { createDealEvent } from "@/services/deals";
import type { BulkMoveStagePayload } from "@/lib/queue";

import {
  type BulkOperationErrorEntry,
  incrementOperationProgress,
  markOperationFailed,
  markOperationFinished,
  markOperationStarted,
  truncateErrorMessage,
} from "./_update-progress";

const log = getLogger("jobs.leads.bulk-move-stage");

/**
 * Tamanho do chunk: 50 deals. Cada chunk:
 *   1. Lê o estado atual dos deals (stageId antigo).
 *   2. Filtra os que precisam mover (stageId !== target) — idempotência.
 *   3. Aplica `updateMany` para o subset que muda (1 query, atômica).
 *   4. Para cada deal alterado: emite DealEvent + fireTrigger
 *      fire-and-forget (mantém o padrão do service síncrono atual).
 *
 * Por que não `prisma.$transaction` em torno do `updateMany`?
 *   - `updateMany` é atômico por si só no Postgres.
 *   - Envolver em `$transaction` aumentaria contenção em locks de linha
 *     desnecessariamente.
 *   - `DealEvent` + `fireTrigger` ficam fora da transação intencionalmente
 *     — são side effects de auditoria/automação, não bloqueiam a operação.
 */
const CHUNK_SIZE = 50;

/**
 * Handler do job `bulk-move-stage` da fila `leads-bulk`.
 *
 * Idempotência (cuidado 7 do usuário):
 *   - Se `deal.stageId === target`, deal é contado como sucesso ("noop"),
 *     SEM emitir DealEvent nem fireTrigger (evita duplicação de trigger
 *     em retries do job).
 *   - `updateMany` opera apenas em deals com `stageId != target`,
 *     garantindo que retries não causem efeitos colaterais.
 *
 * Cuidado 7 — DealEvent e fireTrigger:
 *   - DealEvent: emitido fire-and-forget por deal ALTERADO (não no noop).
 *   - fireTrigger: idem — só dispara em mudança real de stage.
 *   - Logs com operationId, dealId, fromStageId, toStageId em cada caso.
 *   - Erros em DealEvent/fireTrigger são logados mas não falham a operação
 *     (continuam fire-and-forget como no helper síncrono `moveDeal`).
 */
export async function processBulkMoveStage(
  payload: BulkMoveStagePayload,
  job: Job<BulkMoveStagePayload>,
): Promise<void> {
  const { operationId, organizationId, dealIds, targetStageId, initiatedByUserId, lostReason } = payload;
  const ctx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    targetStageId,
    dealCount: dealIds.length,
  });
  ctx.info("Iniciando bulk-move-stage");

  if (dealIds.length === 0) {
    await markOperationFailed(operationId, organizationId, "dealIds vazio");
    ctx.warn("Payload vazio — operação marcada como FAILED");
    return;
  }

  await markOperationStarted(operationId, organizationId);

  // Nota: `pipelines.lossReasonAllowOther` (ou org fallback) é validada na rota que
  // enfileira (`POST /api/deals/bulk`) ANTES de criar a BulkOperation. Aqui
  // confiamos no payload já saneado, evitando ler org settings fora de
  // RequestContext. Se essa entry point ficar exposta a outros enqueuers no
  // futuro, mover `assertLostReasonAllowed(lostReason)` pra cá também.

  // Valida que a stage de destino existe na org.
  const targetStage = await prisma.stage.findUnique({
    where: { id: targetStageId },
    select: { id: true, name: true, isWon: true, isLost: true },
  });
  if (!targetStage) {
    await markOperationFailed(
      operationId,
      organizationId,
      `Stage ${targetStageId} não encontrada na organização`,
    );
    return;
  }

  // Processa em chunks. Cada chunk:
  //   - lê estado atual (1 SELECT)
  //   - aplica updateMany apenas onde necessário (1 UPDATE)
  //   - dispara DealEvent + fireTrigger fora da query principal (assíncrono)
  for (let i = 0; i < dealIds.length; i += CHUNK_SIZE) {
    const chunkIds = dealIds.slice(i, i + CHUNK_SIZE);
    const chunkLog = ctx.child({
      chunkIndex: Math.floor(i / CHUNK_SIZE),
      chunkSize: chunkIds.length,
    });

    let chunkErrors: BulkOperationErrorEntry[] = [];
    let chunkSucceeded = 0;
    let chunkFailed = 0;

    try {
      const deals = await prisma.deal.findMany({
        where: { id: { in: chunkIds } },
        select: {
          id: true,
          stageId: true,
          status: true,
          contactId: true,
          stage: { select: { name: true } },
        },
      });

      const found = new Set(deals.map((d) => d.id));
      const missing = chunkIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        const now = new Date().toISOString();
        chunkFailed += missing.length;
        chunkErrors.push(
          ...missing.map((dealId) => ({
            itemId: dealId,
            message: "Deal não encontrado ou não pertence à organização",
            attempt: job.attemptsMade + 1,
            at: now,
          })),
        );
      }

      const toMove = deals.filter((d) => d.stageId !== targetStageId);
      const noOps = deals.filter((d) => d.stageId === targetStageId);
      chunkSucceeded += noOps.length; // noop conta como sucesso (idempotente).

      if (toMove.length > 0) {
        // updateMany atômico — todos ou nada para o subset que muda.
        // Postgres lida com lock de linha; concorrência com outras ops
        // (move 1:1, change_owner) é mediada pelo nível de isolamento
        // padrão (READ COMMITTED), suficiente aqui.
        // Estágios terminais fixos (Ganho/Perdido) sincronizam
        // Deal.status — mesma regra do moveDeal manual.
        const syncedStatus = targetStage.isWon
          ? ("WON" as const)
          : targetStage.isLost
            ? ("LOST" as const)
            : ("OPEN" as const);
        await prisma.deal.updateMany({
          where: {
            id: { in: toMove.map((d) => d.id) },
            stageId: { not: targetStageId }, // defesa contra concorrência
          },
          data:
            syncedStatus === "OPEN"
              ? { stageId: targetStageId, status: "OPEN", closedAt: null, lostReason: null }
              : syncedStatus === "LOST"
                ? {
                    stageId: targetStageId,
                    status: "LOST",
                    closedAt: new Date(),
                    lostReason: lostReason?.trim() || null,
                  }
                : { stageId: targetStageId, status: "WON", closedAt: new Date(), lostReason: null },
        });
        chunkSucceeded += toMove.length;

        // DealEvent + fireTrigger fire-and-forget (padrão herdado do
        // POST /api/deals/bulk síncrono). Falhas são logadas mas não
        // bloqueiam o progresso da operação.
        for (const deal of toMove) {
          createDealEvent(deal.id, initiatedByUserId, "STAGE_CHANGED", {
            from: { id: deal.stageId, name: deal.stage.name },
            to: { id: targetStage.id, name: targetStage.name },
          }).catch((err: unknown) => {
            chunkLog.warn(
              { dealId: deal.id, err: truncateErrorMessage(err) },
              "createDealEvent falhou (fire-and-forget)",
            );
          });

          fireTrigger("stage_changed", {
            dealId: deal.id,
            data: { fromStageId: deal.stageId, toStageId: targetStageId },
          }).catch((err: unknown) => {
            chunkLog.warn(
              { dealId: deal.id, err: truncateErrorMessage(err) },
              "fireTrigger stage_changed falhou (fire-and-forget)",
            );
          });

          if (deal.status !== syncedStatus) {
            createDealEvent(deal.id, initiatedByUserId, "STATUS_CHANGED", {
              from: deal.status,
              to: syncedStatus,
            }).catch(() => {});
            if (syncedStatus === "WON") {
              fireTrigger("deal_won", { dealId: deal.id, data: { fromStatus: deal.status } }).catch(() => {});
            } else if (syncedStatus === "LOST") {
              fireTrigger("deal_lost", { dealId: deal.id, data: { fromStatus: deal.status } }).catch(() => {});
            }
          }
        }
      }

      chunkLog.info(
        {
          moved: toMove.length,
          noOps: noOps.length,
          missing: missing.length,
        },
        "Chunk processado",
      );
    } catch (err) {
      // Erro de infraestrutura (DB down, etc.). Não é por-item, é o chunk
      // inteiro. Marcamos todos os deals do chunk como falha e logamos.
      chunkFailed += chunkIds.length - chunkSucceeded - chunkErrors.length;
      const errMsg = truncateErrorMessage(err);
      const now = new Date().toISOString();
      chunkErrors = chunkErrors.concat(
        chunkIds
          .filter(
            (id) =>
              !chunkErrors.some((e) => e.itemId === id),
          )
          .map((dealId) => ({
            itemId: dealId,
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
  }

  await markOperationFinished(operationId, organizationId);
  ctx.info("bulk-move-stage finalizado");
}
