/**
 * Inventory (ledger) — porta ÚNICA de movimentos de alocação consumível.
 *
 * Princípios (ver backend/AGENT.md 2026-06-11):
 *   - Saldo do pool = soma de `InventoryMovement.delta`. NUNCA coluna mutável.
 *   - `delta` negativo consome; positivo repõe.
 *   - Toda baixa/reposição roda dentro de `prisma.$transaction` com LOCK da
 *     linha do pool (`SELECT ... FOR UPDATE`), serializando consumos
 *     concorrentes no mesmo pool — não fura saldo na última unidade.
 *   - Recusa saldo insuficiente quando `allowNegative=false` via erro tipado
 *     `InsufficientInventoryError` (a automação consegue tratar).
 *   - Auditoria: cada movimento já é o audit trail (ator/motivo/nota); quando
 *     há `dealId`, emite também um `ActivityEvent` no deal (após commit).
 *
 * Convenção de sinais por reason:
 *   RESTOCK / RESERVATION_RELEASE / WITHDRAWAL  -> delta positivo (repõe)
 *   SALE / HIRE / RESERVATION                   -> delta negativo (consome/reserva)
 *   REVERSAL / ADJUSTMENT                        -> sinal conforme o caso
 */
import type { InventoryReason } from "@prisma/client";

import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { logEvent } from "@/services/activity-log";

/** Erro tipado: saldo insuficiente para consumir/reservar. */
export class InsufficientInventoryError extends Error {
  readonly code = "INSUFFICIENT_INVENTORY";
  constructor(
    readonly poolId: string,
    readonly available: number,
    readonly requested: number,
  ) {
    super(
      `Alocação insuficiente no pool ${poolId}: disponível ${available}, solicitado ${requested}.`,
    );
    this.name = "InsufficientInventoryError";
  }
}

type AnyClient = ScopedTx | typeof prisma;

type MovementInput = {
  poolId: string;
  delta: number;
  reason: InventoryReason;
  dealId?: string | null;
  actorId?: string | null;
  actorType?: string | null;
  note?: string | null;
};

export type PoolStats = {
  poolId: string;
  /** Saldo disponível real (reservas já descontadas). */
  balance: number;
  /** Total provisionado (soma de RESTOCK). */
  capacity: number;
  /** Reservas em aberto (RESERVATION líquido). */
  reserved: number;
  /** Consumido líquido (SALE + HIRE). */
  consumed: number;
};

/** Saldo do pool = soma de todos os deltas. */
export async function getBalance(
  poolId: string,
  client: AnyClient = prisma,
): Promise<number> {
  const agg = await client.inventoryMovement.aggregate({
    where: { poolId },
    _sum: { delta: true },
  });
  return agg._sum.delta ?? 0;
}

/** Estatísticas agregadas do pool (para badges/relatórios). */
export async function getPoolStats(
  poolId: string,
  client: AnyClient = prisma,
): Promise<PoolStats> {
  const rows = await client.inventoryMovement.groupBy({
    by: ["reason"],
    where: { poolId },
    _sum: { delta: true },
  });

  let balance = 0;
  let capacity = 0;
  let reservedSigned = 0;
  let consumedSigned = 0;
  for (const r of rows) {
    const s = r._sum.delta ?? 0;
    balance += s;
    if (r.reason === "RESTOCK") capacity += s;
    if (r.reason === "RESERVATION" || r.reason === "RESERVATION_RELEASE") {
      reservedSigned += s;
    }
    if (r.reason === "SALE" || r.reason === "HIRE") consumedSigned += s;
  }

  return {
    poolId,
    balance,
    capacity,
    reserved: -reservedSigned,
    consumed: -consumedSigned,
  };
}

/**
 * Lock pessimista da linha do pool dentro de uma transação. Serializa
 * leituras/escritas concorrentes no mesmo pool. `$queryRaw` ignora a
 * extension de org, então filtramos `organizationId` manualmente.
 */
async function lockPool(
  tx: ScopedTx,
  poolId: string,
  orgId: string,
): Promise<{ id: string; allowNegative: boolean }> {
  const rows = await tx.$queryRaw<Array<{ id: string; allowNegative: boolean }>>`
    SELECT "id", "allowNegative"
    FROM "inventory_pools"
    WHERE "id" = ${poolId} AND "organizationId" = ${orgId}
    FOR UPDATE
  `;
  const pool = rows[0];
  if (!pool) {
    throw new Error(`inventory: pool ${poolId} não encontrado na organização.`);
  }
  return pool;
}

async function recordMovement(
  tx: ScopedTx,
  input: MovementInput,
  orgId: string,
): Promise<{ id: string }> {
  return tx.inventoryMovement.create({
    data: withOrg(
      {
        poolId: input.poolId,
        delta: input.delta,
        reason: input.reason,
        dealId: input.dealId ?? null,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? null,
        note: input.note ?? null,
      },
      orgId,
    ),
    select: { id: true },
  });
}

/** Emite ActivityEvent no deal (fire-and-forget). Só quando há dealId. */
function auditOnDeal(
  dealId: string | null | undefined,
  type: string,
  meta: Record<string, unknown>,
): void {
  if (!dealId) return;
  void logEvent({
    type,
    entityType: "DEAL",
    entityId: dealId,
    dealId,
    actorType: "AUTOMATION",
    actorLabel: "Estoque",
    meta,
  });
}

export type ConsumeInput = {
  poolId: string;
  /** Quantidade positiva; gravada como delta negativo. */
  qty: number;
  reason?: InventoryReason;
  dealId?: string | null;
  actorId?: string | null;
  actorType?: string | null;
  note?: string | null;
};

/** Consome `qty` do pool (delta negativo). Recusa se estourar o saldo. */
export async function consume(
  input: ConsumeInput,
): Promise<{ movementId: string; balance: number }> {
  if (input.qty <= 0) throw new Error("inventory.consume: qty deve ser > 0.");
  const orgId = getOrgIdOrThrow();
  const reason = input.reason ?? "SALE";

  const result = await prisma.$transaction(async (tx) => {
    const pool = await lockPool(tx, input.poolId, orgId);
    const balance = await getBalance(input.poolId, tx);
    if (!pool.allowNegative && balance < input.qty) {
      throw new InsufficientInventoryError(input.poolId, balance, input.qty);
    }
    const mv = await recordMovement(
      tx,
      { ...input, delta: -input.qty, reason },
      orgId,
    );
    return { movementId: mv.id, balance: balance - input.qty };
  });

  auditOnDeal(input.dealId, "INVENTORY_CONSUMED", {
    poolId: input.poolId,
    qty: input.qty,
    reason,
  });
  return result;
}

export type ReserveInput = Omit<ConsumeInput, "reason">;

/** Reserva `qty` (delta negativo, reason RESERVATION). Recusa se sem saldo. */
export async function reserve(
  input: ReserveInput,
): Promise<{ movementId: string; balance: number }> {
  if (input.qty <= 0) throw new Error("inventory.reserve: qty deve ser > 0.");
  const orgId = getOrgIdOrThrow();

  const result = await prisma.$transaction(async (tx) => {
    const pool = await lockPool(tx, input.poolId, orgId);
    const balance = await getBalance(input.poolId, tx);
    if (!pool.allowNegative && balance < input.qty) {
      throw new InsufficientInventoryError(input.poolId, balance, input.qty);
    }
    const mv = await recordMovement(
      tx,
      { ...input, delta: -input.qty, reason: "RESERVATION" },
      orgId,
    );
    return { movementId: mv.id, balance: balance - input.qty };
  });

  auditOnDeal(input.dealId, "INVENTORY_RESERVED", {
    poolId: input.poolId,
    qty: input.qty,
  });
  return result;
}

/** Libera `qty` reservado (delta positivo, reason RESERVATION_RELEASE). */
export async function release(
  input: ReserveInput,
): Promise<{ movementId: string; balance: number }> {
  if (input.qty <= 0) throw new Error("inventory.release: qty deve ser > 0.");
  const orgId = getOrgIdOrThrow();

  const result = await prisma.$transaction(async (tx) => {
    await lockPool(tx, input.poolId, orgId);
    const mv = await recordMovement(
      tx,
      { ...input, delta: input.qty, reason: "RESERVATION_RELEASE" },
      orgId,
    );
    const balance = await getBalance(input.poolId, tx);
    return { movementId: mv.id, balance };
  });

  auditOnDeal(input.dealId, "INVENTORY_RELEASED", {
    poolId: input.poolId,
    qty: input.qty,
  });
  return result;
}

export type RestockInput = {
  poolId: string;
  qty: number;
  reason?: InventoryReason;
  dealId?: string | null;
  actorId?: string | null;
  actorType?: string | null;
  note?: string | null;
};

/** Repõe `qty` (delta positivo). Default reason RESTOCK. */
export async function restock(
  input: RestockInput,
): Promise<{ movementId: string; balance: number }> {
  if (input.qty <= 0) throw new Error("inventory.restock: qty deve ser > 0.");
  const orgId = getOrgIdOrThrow();
  const reason = input.reason ?? "RESTOCK";

  const result = await prisma.$transaction(async (tx) => {
    await lockPool(tx, input.poolId, orgId);
    const mv = await recordMovement(
      tx,
      { ...input, delta: input.qty, reason },
      orgId,
    );
    const balance = await getBalance(input.poolId, tx);
    return { movementId: mv.id, balance };
  });

  auditOnDeal(input.dealId, "INVENTORY_RESTOCKED", {
    poolId: input.poolId,
    qty: input.qty,
    reason,
  });
  return result;
}

/**
 * Estorna TODOS os movimentos de um deal: para cada pool tocado pelo deal,
 * lança um movimento REVERSAL com o inverso do saldo líquido daquele deal
 * naquele pool. Idempotente: chamar de novo é no-op (o net já é zero porque
 * o REVERSAL anterior entra na soma).
 */
export async function reverse(
  dealId: string,
  opts?: { actorId?: string | null; note?: string | null },
): Promise<{ reversedPools: number }> {
  const orgId = getOrgIdOrThrow();

  const result = await prisma.$transaction(async (tx) => {
    const grouped = await tx.inventoryMovement.groupBy({
      by: ["poolId"],
      where: { dealId },
      _sum: { delta: true },
    });

    let reversedPools = 0;
    for (const g of grouped) {
      const net = g._sum.delta ?? 0;
      if (net === 0) continue;
      await lockPool(tx, g.poolId, orgId);
      await recordMovement(
        tx,
        {
          poolId: g.poolId,
          delta: -net,
          reason: "REVERSAL",
          dealId,
          actorId: opts?.actorId ?? null,
          note: opts?.note ?? "Estorno de deal",
        },
        orgId,
      );
      reversedPools++;
    }
    return { reversedPools };
  });

  if (result.reversedPools > 0) {
    auditOnDeal(dealId, "INVENTORY_REVERSED", {
      pools: result.reversedPools,
    });
  }
  return result;
}

export type AdjustInput = {
  poolId: string;
  /** Delta assinado: positivo soma, negativo subtrai. */
  delta: number;
  dealId?: string | null;
  actorId?: string | null;
  actorType?: string | null;
  note?: string | null;
};

/**
 * Ajuste manual do saldo (reason ADJUSTMENT). `delta` assinado. Subtrações
 * respeitam `allowNegative` (erro tipado se estouraria). Usado pelo painel de
 * alocação (sob `allocation:adjust`) e pelo step de automação.
 */
export async function adjust(
  input: AdjustInput,
): Promise<{ movementId: string; balance: number }> {
  if (input.delta === 0) throw new Error("inventory.adjust: delta não pode ser 0.");
  const orgId = getOrgIdOrThrow();

  const result = await prisma.$transaction(async (tx) => {
    const pool = await lockPool(tx, input.poolId, orgId);
    const balance = await getBalance(input.poolId, tx);
    if (!pool.allowNegative && input.delta < 0 && balance + input.delta < 0) {
      throw new InsufficientInventoryError(input.poolId, balance, -input.delta);
    }
    const mv = await recordMovement(
      tx,
      { ...input, reason: "ADJUSTMENT" },
      orgId,
    );
    return { movementId: mv.id, balance: balance + input.delta };
  });

  auditOnDeal(input.dealId, "INVENTORY_ADJUSTED", {
    poolId: input.poolId,
    delta: input.delta,
  });
  return result;
}
