/**
 * Motivos de perda que este agente pode gravar. Lista vazia ou opção
 * desligada = o move de etapa não mexe no motivo (comportamento anterior).
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { prisma } from "@/lib/prisma";

export type LossReasonChoice = { id: string; label: string };

export async function configuredLossReasons(config: V2AgentConfig): Promise<LossReasonChoice[]> {
  const cfg = config.closure?.lossReasons;
  if (!cfg?.enabled) return [];
  const ids = [...new Set((cfg.reasonIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await prisma.lossReason.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, label: true },
    orderBy: { position: "asc" },
  });
  return rows
    .map((r) => ({ id: r.id, label: r.label.trim() }))
    .filter((r) => r.label.length > 0);
}

/** Casa o texto do modelo com um motivo da lista. Devolve o rótulo do catálogo. */
export function matchLossReason(choices: LossReasonChoice[], raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const wanted = fold(text);
  const hit = choices.find((r) => r.id === text || fold(r.label) === wanted);
  return hit?.label ?? null;
}
