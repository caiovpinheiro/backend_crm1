/**
 * Estado de dono da conversa (owner) da v2.
 * pessoa | automação | agente | ninguém
 */

import type { V2Owner } from "@/lib/ai-v2/types";

export type V2OwnerTransition = {
  from: V2Owner;
  to: V2Owner;
  reason: string;
};

/** Regras de precedência para mudança de dono. */
export function canChangeOwner(from: V2Owner, to: V2Owner): boolean {
  if (from === to) return true;
  // "pessoa" só perde para "agente" (devolução) ou "automação" (transferência para automação).
  // "agente" perde para "pessoa" ou "automação".
  // "ninguém" aceita qualquer.
  // "automação" perde para pessoa/agente.
  if (from === "pessoa") return to === "agente" || to === "automation" || to === "ninguem";
  if (from === "agente") return true;
  if (from === "automation") return to === "pessoa" || to === "agente" || to === "ninguem";
  return true;
}

export function ownerTransitionMessage(transition: V2OwnerTransition): string {
  return `dono: ${transition.from} → ${transition.to} (${transition.reason})`;
}

export function parseOwner(raw: string | null | undefined): V2Owner {
  if (!raw) return "agente";
  if (["pessoa", "automation", "agente", "ninguem"].includes(raw)) return raw as V2Owner;
  return "agente";
}
