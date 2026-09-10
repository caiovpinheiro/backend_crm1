/**
 * Claim atômico de atribuição (compare-and-swap) — garantia comum
 * anti-dupla-atribuição dos modos smart e leads.
 *
 * Um único UPDATE condicional por alvo, DENTRO da transaction de atribuição
 * do motor: `count === 0` significa que outro fluxo (smart, leads, inbox
 * manual, IA) venceu a corrida e a tx deve abortar a atribuição. Quem escreve
 * owner grava também `assignedVia` (origem da atribuição vigente) e consome a
 * rota pendente (`routeMode = null`).
 */

import type { ScopedTx } from "@/lib/prisma";

export type AssignmentVia = "smart" | "leads";

/**
 * CAS na conversa.
 * - Sem `expectedOwnerId`: só vence se a conversa está sem dono humano
 *   (`assignedToId IS NULL` ou dono IA — handoff IA→humano legítimo).
 * - Com `expectedOwnerId`: reassign/transferência — só vence se o dono atual
 *   ainda é o lido na seleção (alguém mudou no meio → perde).
 */
export async function claimConversationAssignmentTx(
  tx: ScopedTx,
  args: {
    conversationId: string;
    userId: string;
    via: AssignmentVia;
    expectedOwnerId?: string | null;
  },
): Promise<boolean> {
  const res = await tx.conversation.updateMany({
    where: args.expectedOwnerId
      ? { id: args.conversationId, assignedToId: args.expectedOwnerId }
      : {
          id: args.conversationId,
          OR: [{ assignedToId: null }, { assignedTo: { type: "AI" } }],
        },
    data: {
      assignedToId: args.userId,
      assignedVia: args.via,
      routeMode: null,
    },
  });
  return res.count === 1;
}

/**
 * CAS no deal (alvo sem conversa). Mesma semântica do de conversa:
 * sem `expectedOwnerId` só vence com `ownerId IS NULL`.
 */
export async function claimDealAssignmentTx(
  tx: ScopedTx,
  args: {
    dealId: string;
    userId: string;
    via: AssignmentVia;
    expectedOwnerId?: string | null;
  },
): Promise<boolean> {
  const res = await tx.deal.updateMany({
    where: args.expectedOwnerId
      ? { id: args.dealId, ownerId: args.expectedOwnerId }
      : { id: args.dealId, ownerId: null },
    data: { ownerId: args.userId, assignedVia: args.via },
  });
  return res.count === 1;
}
