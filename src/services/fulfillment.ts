/**
 * Fulfillment agnóstico (PRD catalogo-capacidades, capability `fulfillment`).
 *
 * Ao GANHAR um deal COMMERCIAL, para cada produto com a capability
 * `fulfillment` ligada, age conforme `config.creationTrigger`:
 *   - ON_WON:        cria deal OPERATIONAL no pipeline configurado + DealLink(ORIGINATED).
 *   - BY_AUTOMATION: não faz nada aqui (um passo de automação cria a operação).
 *   - MANUAL (padrão): cria tarefa/notificação "configurar operação".
 *
 * SEM verticais: nenhuma referência a curso/vaga/SaaS. A decisão vem 100% da
 * config Zod da capability. Coexiste com `product-fulfillment.ts` (legado por
 * kind), que continua intacto.
 *
 * Best-effort e pós-commit: falhas viram ActivityEvent + warn, nunca derrubam
 * o ganho do deal.
 */
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { logEvent } from "@/services/activity-log";
import { createDeal } from "@/services/deals";

const log = getLogger("fulfillment");
const FULFILLMENT_KEY = "fulfillment";

type FulfillmentConfig = {
  creationTrigger: "MANUAL" | "BY_AUTOMATION" | "ON_WON";
  operationalPipelineId: string | null;
  operationalStageId: string | null;
};

function parseConfig(config: unknown): FulfillmentConfig {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const trigger = c.creationTrigger;
  return {
    creationTrigger:
      trigger === "ON_WON" || trigger === "BY_AUTOMATION" ? trigger : "MANUAL",
    operationalPipelineId:
      typeof c.operationalPipelineId === "string" ? c.operationalPipelineId : null,
    operationalStageId:
      typeof c.operationalStageId === "string" ? c.operationalStageId : null,
  };
}

/**
 * Resolve a config de fulfillment efetiva de um produto: ProductCapability
 * (override) com fallback no CatalogCapability do catálogo do produto.
 */
async function resolveFulfillmentConfig(
  productId: string,
  catalogId: string | null,
): Promise<FulfillmentConfig | null> {
  const prodCap = await prisma.productCapability.findFirst({
    where: { productId, capabilityKey: FULFILLMENT_KEY, enabled: true },
    select: { config: true },
  });
  if (prodCap) return parseConfig(prodCap.config);

  if (!catalogId) return null;
  const catCap = await prisma.catalogCapability.findFirst({
    where: { catalogId, capabilityKey: FULFILLMENT_KEY, enabled: true },
    select: { config: true },
  });
  return catCap ? parseConfig(catCap.config) : null;
}

/** Estágio de entrada de um pipeline (isIncoming, senão menor posição aberta). */
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

/** Resolve o estágio inicial da operação a partir da config. */
async function resolveOperationalStage(
  cfg: FulfillmentConfig,
): Promise<string | null> {
  if (cfg.operationalStageId) return cfg.operationalStageId;
  if (cfg.operationalPipelineId) return pickIncomingStageId(cfg.operationalPipelineId);
  return null;
}

/**
 * Gancho de deal-ganho agnóstico. Para cada produto do deal com capability
 * `fulfillment`, dispara a operação conforme o gatilho configurado.
 */
export async function onCommercialDealWon(dealId: string): Promise<void> {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        title: true,
        dealRole: true,
        contactId: true,
        products: {
          select: {
            product: { select: { id: true, name: true, catalogId: true } },
          },
        },
      },
    });
    // Só deals comerciais originam operação (PRD §5).
    if (!deal || deal.dealRole !== "COMMERCIAL") return;

    for (const dp of deal.products) {
      const product = dp.product;
      const cfg = await resolveFulfillmentConfig(product.id, product.catalogId);
      if (!cfg) continue;

      if (cfg.creationTrigger === "ON_WON") {
        await createOperationalDeal(deal, product, cfg);
      } else if (cfg.creationTrigger === "MANUAL") {
        void logEvent({
          type: "FULFILLMENT_SETUP_REQUIRED",
          actorType: "HUMAN",
          entityType: "DEAL",
          entityId: dealId,
          dealId,
          meta: { productId: product.id, productName: product.name },
        });
      }
      // BY_AUTOMATION: intencionalmente no-op aqui.
    }
  } catch (err) {
    log.warn("onCommercialDealWon falhou:", {
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function createOperationalDeal(
  deal: { id: string; title: string; contactId: string | null },
  product: { id: string; name: string },
  cfg: FulfillmentConfig,
): Promise<void> {
  const stageId = await resolveOperationalStage(cfg);
  if (!stageId) {
    void logEvent({
      type: "FULFILLMENT_SKIPPED_NO_STAGE",
      actorType: "AUTOMATION",
      actorLabel: "Fulfillment",
      entityType: "DEAL",
      entityId: deal.id,
      dealId: deal.id,
      meta: { productId: product.id },
    });
    return;
  }

  const operational = await createDeal({
    title: `Operação: ${product.name}`,
    stageId,
    contactId: deal.contactId,
    dealRole: "OPERATIONAL",
  });

  await prisma.dealLink.create({
    data: withOrgFromCtx({
      fromDealId: deal.id,
      toDealId: operational.id,
      linkType: "ORIGINATED",
    }),
  });

  void logEvent({
    type: "FULFILLMENT_OPERATION_CREATED",
    actorType: "AUTOMATION",
    actorLabel: "Fulfillment",
    entityType: "DEAL",
    entityId: deal.id,
    dealId: deal.id,
    meta: { operationalDealId: operational.id, productId: product.id },
  });
}
