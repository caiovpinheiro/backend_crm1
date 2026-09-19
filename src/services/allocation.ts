/**
 * Allocation — porta ÚNICA, agnóstica, de movimentos de alocação consumível
 * (PRD catalogo-capacidades, capability `allocation`).
 *
 * Coexistência aditiva (AGENT.md 2026-06-13): a implementação física do pool é
 * `InventoryPool`/`InventoryMovement` (service `inventory.ts`), que já é
 * transacional (lock pessimista da linha), auditado (cada movimento é o trail)
 * e recusa saldo insuficiente via `InsufficientInventoryError`. Este módulo é a
 * fachada com o vocabulário do PRD (AllocationPool/Movement) e adiciona o que
 * faltava: o **alerta de saldo baixo** (`lowThreshold` da config da capability).
 *
 * Nada aqui conhece verticais. O `lowThreshold` vem da config Zod da capability
 * `allocation` (ProductCapability, com fallback no CatalogCapability).
 */
import { prisma } from "@/lib/prisma";
import {
  type ConsumeInput,
  type ReserveInput,
  InsufficientInventoryError,
  consume as consumeRaw,
  getBalance,
  reserve as reserveRaw,
} from "@/services/inventory";
import { logEvent } from "@/services/activity-log";

// Reexporta a API estável do ledger com o nome de domínio do PRD.
export {
  InsufficientInventoryError,
  getBalance,
  getPoolStats,
  release,
  restock,
  reverse,
  adjust,
} from "@/services/inventory";
export type {
  PoolStats,
  ConsumeInput,
  ReserveInput,
  RestockInput,
  AdjustInput,
} from "@/services/inventory";

const ALLOCATION_KEY = "allocation";

/**
 * Resolve o `lowThreshold` configurado para o pool: olha a capability
 * `allocation` do produto do pool (ProductCapability) e, na ausência, a do
 * catálogo (CatalogCapability). Retorna null se não houver produto/config.
 */
async function resolveLowThreshold(poolId: string): Promise<number | null> {
  const pool = await prisma.inventoryPool.findUnique({
    where: { id: poolId },
    select: { productId: true, product: { select: { catalogId: true } } },
  });
  if (!pool?.productId) return null;

  const prodCap = await prisma.productCapability.findFirst({
    where: { productId: pool.productId, capabilityKey: ALLOCATION_KEY, enabled: true },
    select: { config: true },
  });
  const fromProduct = readLowThreshold(prodCap?.config);
  if (fromProduct !== null) return fromProduct;

  const catalogId = pool.product?.catalogId;
  if (!catalogId) return null;
  const catCap = await prisma.catalogCapability.findFirst({
    where: { catalogId, capabilityKey: ALLOCATION_KEY, enabled: true },
    select: { config: true },
  });
  return readLowThreshold(catCap?.config);
}

function readLowThreshold(config: unknown): number | null {
  if (!config || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>).lowThreshold;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Dispara evento de saldo baixo quando o balanço cruza o limite. */
async function maybeAlertLow(
  poolId: string,
  balance: number,
  dealId: string | null | undefined,
): Promise<void> {
  const threshold = await resolveLowThreshold(poolId);
  if (threshold === null || balance > threshold) return;
  void logEvent({
    type: "ALLOCATION_LOW",
    actorType: "AUTOMATION",
    actorLabel: "Alocação",
    entityType: dealId ? "DEAL" : "PRODUCT",
    entityId: dealId ?? poolId,
    dealId: dealId ?? null,
    meta: { poolId, balance, threshold },
  });
}

/** Consome do pool e dispara alerta de saldo baixo se cruzar o limite. */
export async function consume(
  input: ConsumeInput,
): Promise<{ movementId: string; balance: number }> {
  const result = await consumeRaw(input);
  await maybeAlertLow(input.poolId, result.balance, input.dealId);
  return result;
}

/** Reserva no pool e dispara alerta de saldo baixo se cruzar o limite. */
export async function reserve(
  input: ReserveInput,
): Promise<{ movementId: string; balance: number }> {
  const result = await reserveRaw(input);
  await maybeAlertLow(input.poolId, result.balance, input.dealId);
  return result;
}
