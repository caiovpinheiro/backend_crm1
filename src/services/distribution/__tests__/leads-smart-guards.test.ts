/**
 * Proteções do caminho smart contra o modo leads:
 * - claimConversationAssignmentTx: CAS por precondição (sem dono / IA /
 *   dono esperado) — um UPDATE condicional, count=0 = outro fluxo venceu.
 * - ABERTA_SEM_RESPONSAVEL: a fila derivada smart exclui conversas marcadas
 *   (routeMode="leads") e conversas de departamentos no modo leads.
 */

import { describe, expect, it, vi } from "vitest";

import {
  claimConversationAssignmentTx,
  claimDealAssignmentTx,
} from "../claim";
import { ABERTA_SEM_RESPONSAVEL } from "../pending-shared";

function txWithConversation(updateManyResult: { count: number }) {
  const updateMany = vi.fn(async () => updateManyResult);
  return {
    tx: { conversation: { updateMany } } as never,
    updateMany,
  };
}

describe("claimConversationAssignmentTx", () => {
  it("sem expectedOwnerId: precondição é sem dono OU dono IA", async () => {
    const { tx, updateMany } = txWithConversation({ count: 1 });
    const ok = await claimConversationAssignmentTx(tx, {
      conversationId: "c1",
      userId: "u1",
      via: "leads",
    });
    expect(ok).toBe(true);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { assignedToId: null },
      { assignedTo: { type: "AI" } },
    ]);
    // grava origem e consome a rota
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      assignedToId: "u1",
      assignedVia: "leads",
      routeMode: null,
    });
  });

  it("com expectedOwnerId (reassign): só vence se o dono ainda é o esperado", async () => {
    const { tx, updateMany } = txWithConversation({ count: 0 });
    const ok = await claimConversationAssignmentTx(tx, {
      conversationId: "c1",
      userId: "u2",
      via: "smart",
      expectedOwnerId: "u1",
    });
    expect(ok).toBe(false);
    expect(updateMany.mock.calls[0][0].where.assignedToId).toBe("u1");
  });

  it("deal-only: CAS em Deal.ownerId", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = { deal: { updateMany } } as never;
    const ok = await claimDealAssignmentTx(tx, {
      dealId: "d1",
      userId: "u1",
      via: "leads",
    });
    expect(ok).toBe(true);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "d1",
      ownerId: null,
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      ownerId: "u1",
      assignedVia: "leads",
    });
  });
});

describe("ABERTA_SEM_RESPONSAVEL (fila derivada smart)", () => {
  it("exclui routeMode=leads sem excluir NULL (semântica de 3 valores)", () => {
    expect(ABERTA_SEM_RESPONSAVEL.OR).toEqual([
      { routeMode: null },
      { routeMode: { not: "leads" } },
    ]);
  });

  it("exclui conversas de departamentos no modo leads", () => {
    expect(ABERTA_SEM_RESPONSAVEL.NOT).toEqual({
      department: { distributionMode: "leads" },
    });
  });

  it("mantém os critérios atuais da fila smart", () => {
    expect(ABERTA_SEM_RESPONSAVEL.assignedToId).toBeNull();
    expect(ABERTA_SEM_RESPONSAVEL.lastInboundAt).toEqual({ not: null });
    expect(ABERTA_SEM_RESPONSAVEL.status).toBe("OPEN");
  });
});
