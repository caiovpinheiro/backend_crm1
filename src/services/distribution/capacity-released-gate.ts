/**
 * Gate do worker em `capacity_released`: só drena se houver vaga
 * (Entrada + Aguardando < queueLimit). Sem COUNT da fila de espera.
 *
 * Volume = `DistributionResponsible.queueLimit` (teto por consultor).
 * Carga = `getQueueCounts` (mesmas abas da inbox).
 * A API só enfileira; esta checagem corre no `worker-distribution`.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";

import { consultantHasFreeSlot } from "./pending-drain-guard";
import { getQueueCounts } from "./queue";

export type CapacitySnapshot = {
  userId: string;
  queueLimit: number;
  queueCount: number;
};

export type CapacityReleasedDecision = "skip_at_capacity" | "drain";

export function decideCapacityReleasedDrain(opts: {
  snapshots: CapacitySnapshot[];
}): CapacityReleasedDecision {
  if (opts.snapshots.some((s) => consultantHasFreeSlot(s.queueCount, s.queueLimit))) {
    return "drain";
  }
  return "skip_at_capacity";
}

async function loadCapacitySnapshots(
  userId?: string | null,
): Promise<CapacitySnapshot[]> {
  if (userId) {
    const cfg = await prisma.distributionResponsible.findFirst({
      where: { userId },
      select: { queueLimit: true },
    });
    const counts = await getQueueCounts([userId]);
    return [
      {
        userId,
        queueLimit: cfg?.queueLimit ?? 0,
        queueCount: counts.get(userId) ?? 0,
      },
    ];
  }

  const rows = await prisma.distributionResponsible.findMany({
    where: { participates: true, queueLimit: { gt: 0 } },
    select: { userId: true, queueLimit: true },
  });
  if (rows.length === 0) return [];
  const counts = await getQueueCounts(rows.map((r) => r.userId));
  return rows.map((r) => ({
    userId: r.userId,
    queueLimit: r.queueLimit,
    queueCount: counts.get(r.userId) ?? 0,
  }));
}

export async function evaluateCapacityReleasedDrain(opts: {
  userId?: string | null;
}): Promise<{
  proceed: boolean;
  reason: "at_capacity" | "has_slot";
  load: number;
  volume: number;
}> {
  if (!getOrgIdOrNull()) {
    return { proceed: false, reason: "at_capacity", load: 0, volume: 0 };
  }

  const snapshots = await loadCapacitySnapshots(opts.userId);
  const decision = decideCapacityReleasedDrain({ snapshots });

  const slotted = snapshots.find((s) =>
    consultantHasFreeSlot(s.queueCount, s.queueLimit),
  );
  if (decision === "drain" && slotted) {
    return {
      proceed: true,
      reason: "has_slot",
      load: slotted.queueCount,
      volume: slotted.queueLimit,
    };
  }

  const first = snapshots[0];
  return {
    proceed: false,
    reason: "at_capacity",
    load: first?.queueCount ?? 0,
    volume: first?.queueLimit ?? 0,
  };
}
