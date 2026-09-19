/**
 * Fulfillment de produtos multi-tipo — orquestra o ledger de inventário a
 * partir dos eventos de deal (ganho/reaberto/perdido e move no funil B2C).
 *
 * Tudo aqui é BEST-EFFORT e roda PÓS-COMMIT do deal: nunca derruba a
 * transação principal do deal. Falhas (ex.: saldo insuficiente em consumo
 * ON_WON) viram ActivityEvent + console.warn, sem reverter o ganho.
 * O bloqueio "amigável" por falta de saldo aplica-se ao funil B2C de
 * candidatos (reserve/consume), tratado via erro tipado no service.
 *
 * Modo paralelo: este caminho NÃO toca `Product.stock`/`consume_stock`
 * (legado intacto). Só age sobre pools novos (InventoryPool).
 */
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { logEvent } from "@/services/activity-log";
import { createDeal } from "@/services/deals";
import {
  InsufficientInventoryError,
  consume,
  release,
  reserve,
  restock,
  reverse,
} from "@/services/inventory";
import {
  onDealReverted as onDealRevertedQuotas,
  onDealWon as onDealWonQuotas,
} from "@/services/quota";

function toQty(value: unknown): number {
  const n = Math.round(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Escolhe o pool ON_WON do produto: prefere o global (orgUnitId nulo). */
function pickOnWonPool<T extends { orgUnitId: string | null; consumeTrigger: string }>(
  pools: T[],
): T | undefined {
  const onWon = pools.filter((p) => p.consumeTrigger === "ON_WON");
  return onWon.find((p) => p.orgUnitId === null) ?? onWon[0];
}

/** Estágio de entrada de um pipeline (isIncoming, senão menor posição). */
async function pickIncomingStageId(pipelineId: string): Promise<string | null> {
  const incoming = await prisma.stage.findFirst({
    where: { pipelineId, isIncoming: true },
    select: { id: true },
  });
  if (incoming) return incoming.id;
  const first = await prisma.stage.findFirst({
    where: { pipelineId, isWon: false, isLost: false },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  return first?.id ?? null;
}

/**
 * Gancho de deal-ganho. Para cada DealProduct:
 *  (a) consome pools ON_WON (qty = quantidade);
 *  (b) Curso com pós-venda -> cria deal no pipeline pós-venda;
 *  (c) Vaga (JOB_OPENING) -> cria JobOpening + pool de vagas (alocação = qty).
 */
export async function onDealWon(dealId: string): Promise<void> {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        title: true,
        contactId: true,
        contact: { select: { companyId: true } },
        products: {
          select: {
            quantity: true,
            product: {
              select: {
                id: true,
                name: true,
                kind: true,
                inventoryPools: {
                  select: { id: true, orgUnitId: true, consumeTrigger: true },
                },
                courseConfig: { select: { postSalePipelineId: true } },
              },
            },
          },
        },
      },
    });
    if (!deal) return;

    for (const dp of deal.products) {
      const product = dp.product;
      const qty = toQty(dp.quantity);

      // (a) Consumo ON_WON
      const pool = pickOnWonPool(product.inventoryPools);
      if (pool && qty > 0) {
        try {
          await consume({
            poolId: pool.id,
            qty,
            reason: "SALE",
            dealId,
            note: `Baixa ON_WON: ${product.name}`,
          });
        } catch (err) {
          if (err instanceof InsufficientInventoryError) {
            void logEvent({
              type: "INVENTORY_CONSUME_FAILED",
              actorType: "AUTOMATION",
              actorLabel: "Fulfillment",
              entityType: "DEAL",
              entityId: dealId,
              dealId,
              meta: {
                productId: product.id,
                poolId: pool.id,
                requested: err.requested,
                available: err.available,
              },
            });
          } else {
            throw err;
          }
        }
      }

      // (b) Curso pós-venda
      if (
        product.kind === "COURSE" &&
        product.courseConfig?.postSalePipelineId &&
        deal.contactId
      ) {
        const stageId = await pickIncomingStageId(
          product.courseConfig.postSalePipelineId,
        );
        if (stageId) {
          const created = await createDeal({
            title: `Pós-venda: ${product.name}`,
            stageId,
            contactId: deal.contactId,
          });
          void logEvent({
            type: "COURSE_POST_SALE_CREATED",
            actorType: "AUTOMATION",
            actorLabel: "Fulfillment",
            entityType: "DEAL",
            entityId: dealId,
            dealId,
            meta: { postSaleDealId: created.id, productId: product.id },
          });
        }
      }

      // (c) Vaga: cria JobOpening + pool de vagas
      if (product.kind === "JOB_OPENING" && qty > 0) {
        const clientCompanyId = deal.contact?.companyId;
        if (!clientCompanyId) {
          void logEvent({
            type: "JOB_OPENING_SKIPPED_NO_COMPANY",
            actorType: "AUTOMATION",
            actorLabel: "Fulfillment",
            entityType: "DEAL",
            entityId: dealId,
            dealId,
            meta: { productId: product.id },
          });
          continue;
        }
        const createdPool = await prisma.inventoryPool.create({
          data: withOrgFromCtx({
            productId: product.id,
            consumeTrigger: "MANUAL",
            allowNegative: false,
          }),
          select: { id: true },
        });
        await restock({
          poolId: createdPool.id,
          qty,
          note: `Vagas da venda ${deal.title}`,
        });
        const job = await prisma.jobOpening.create({
          data: withOrgFromCtx({
            productId: product.id,
            clientCompanyId,
            title: product.name,
            b2bDealId: dealId,
            poolId: createdPool.id,
            status: "OPEN",
          }),
          select: { id: true },
        });
        void logEvent({
          type: "JOB_OPENING_CREATED",
          actorType: "AUTOMATION",
          actorLabel: "Fulfillment",
          entityType: "DEAL",
          entityId: dealId,
          dealId,
          meta: { jobOpeningId: job.id, productId: product.id, vacancies: qty },
        });
      }
    }
  } catch (err) {
    console.warn("[product-fulfillment] onDealWon falhou:", {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Cotas de desconto (RN-07): consome/confirma cotas SELECTED/RESERVED.
  // Best-effort — mesmo padrão dos demais efeitos pós-ganho (nunca derruba
  // o ganho do deal). O `refreshDealPriceSnapshots` interno mantém os
  // snapshots consistentes.
  try {
    await onDealWonQuotas(dealId);
  } catch (err) {
    console.warn("[product-fulfillment] onDealWon (quotas) falhou:", {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reabertura/estorno: lança os inversos de todos os movimentos do deal.
 * Idempotente (reverse é no-op se net já é zero). Também serve de
 * "withdrawal" quando um deal de candidato é perdido (repõe a vaga).
 */
export async function onDealReverted(dealId: string): Promise<void> {
  try {
    await reverse(dealId, { note: "Estorno por reabertura/perda do deal" });
  } catch (err) {
    console.warn("[product-fulfillment] onDealReverted falhou:", {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Cotas de desconto (RN-07): devolve saldo de RESERVED/CONSUMED e marca
  // RETURNED. Best-effort igual ao inventário — falha aqui não trava a
  // reabertura/perda.
  try {
    await onDealRevertedQuotas(dealId);
  } catch (err) {
    console.warn("[product-fulfillment] onDealReverted (quotas) falhou:", {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Move no funil B2C de candidatos. Entra no estágio de reserva -> reserve(1);
 * entra no de consumo -> libera a reserva do candidato e consome (HIRE).
 * Lança `InsufficientInventoryError` quando não há vaga (tratável pela rota
 * para erro amigável).
 */
export async function onCandidateStageMove(
  candidateDealId: string,
  targetStageId: string,
): Promise<void> {
  const stage = await prisma.stage.findUnique({
    where: { id: targetStageId },
    select: { pipelineId: true },
  });
  if (!stage) return;

  const job = await prisma.jobOpening.findFirst({
    where: { candidatePipelineId: stage.pipelineId },
    select: {
      id: true,
      poolId: true,
      reserveStageId: true,
      consumeStageId: true,
    },
  });
  if (!job) return;

  if (job.reserveStageId && targetStageId === job.reserveStageId) {
    await reserve({ poolId: job.poolId, qty: 1, dealId: candidateDealId });
    return;
  }

  if (job.consumeStageId && targetStageId === job.consumeStageId) {
    // Libera eventual reserva deste candidato antes de consumir a vaga.
    const reservedByThisCandidate = await prisma.inventoryMovement.aggregate({
      where: {
        poolId: job.poolId,
        dealId: candidateDealId,
        reason: "RESERVATION",
      },
      _sum: { delta: true },
    });
    const reserved = -(reservedByThisCandidate._sum.delta ?? 0);
    if (reserved > 0) {
      await release({ poolId: job.poolId, qty: reserved, dealId: candidateDealId });
    }
    await consume({
      poolId: job.poolId,
      qty: 1,
      reason: "HIRE",
      dealId: candidateDealId,
      note: "Contratação (funil B2C)",
    });

    // Fecha a vaga quando o pool zera.
    const remaining = await prisma.inventoryMovement.aggregate({
      where: { poolId: job.poolId },
      _sum: { delta: true },
    });
    if ((remaining._sum.delta ?? 0) <= 0) {
      await prisma.jobOpening.update({
        where: { id: job.id },
        data: { status: "FILLED" },
      });
    }
  }
}
