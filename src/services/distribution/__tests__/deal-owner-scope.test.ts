/**
 * "Manter dono do negócio" por departamento: decisão e atribuição só da
 * conversa (sem tocar contato nem negócio).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const departmentFindUnique = vi.fn();
const dealFindFirst = vi.fn();
const conversationFindUnique = vi.fn();
const txConversationFindUnique = vi.fn();
const txConversationUpdate = vi.fn();
const txUserFindUnique = vi.fn();
const txContactUpdate = vi.fn();
const txDealUpdateMany = vi.fn();
const logConversationAssigneeChanges = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    department: { findUnique: (...a: unknown[]) => departmentFindUnique(...a) },
    deal: { findFirst: (...a: unknown[]) => dealFindFirst(...a) },
    conversation: {
      findUnique: (...a: unknown[]) => conversationFindUnique(...a),
    },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        conversation: {
          findUnique: (...a: unknown[]) => txConversationFindUnique(...a),
          update: (...a: unknown[]) => txConversationUpdate(...a),
        },
        user: { findUnique: (...a: unknown[]) => txUserFindUnique(...a) },
        contact: { update: (...a: unknown[]) => txContactUpdate(...a) },
        deal: { updateMany: (...a: unknown[]) => txDealUpdateMany(...a) },
      }),
  },
}));

vi.mock("@/services/deals", () => ({
  logConversationAssigneeChanges: (...a: unknown[]) =>
    logConversationAssigneeChanges(...a),
}));

const {
  departmentKeepsDealOwner,
  resolveKeepDealOwner,
  assignConversationOnly,
} = await import("../deal-owner-scope");

describe("departmentKeepsDealOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sem departamento = regra padrão (troca o dono)", async () => {
    expect(await departmentKeepsDealOwner(null)).toBe(false);
    expect(departmentFindUnique).not.toHaveBeenCalled();
  });

  it("lê a flag do departamento", async () => {
    departmentFindUnique.mockResolvedValueOnce({ keepDealOwner: true });
    expect(await departmentKeepsDealOwner("d1")).toBe(true);
    departmentFindUnique.mockResolvedValueOnce({ keepDealOwner: false });
    expect(await departmentKeepsDealOwner("d1")).toBe(false);
    departmentFindUnique.mockResolvedValueOnce(null);
    expect(await departmentKeepsDealOwner("d1")).toBe(false);
  });
});

describe("resolveKeepDealOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealFindFirst.mockResolvedValue({ id: "deal1" });
    departmentFindUnique.mockResolvedValue({ keepDealOwner: true });
  });

  it("sem conversa nunca mantém (não há o que atender separado)", async () => {
    expect(
      await resolveKeepDealOwner({ conversationId: null, contactId: "ct1", departmentId: "d1" }),
    ).toBe(false);
  });

  it("departamento com a flag + negócio com dono humano → mantém", async () => {
    expect(
      await resolveKeepDealOwner({ conversationId: "c1", contactId: "ct1", departmentId: "d1" }),
    ).toBe(true);
    expect(dealFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contactId: "ct1",
          status: "OPEN",
          owner: { type: "HUMAN" },
        }),
      }),
    );
  });

  it("negócio sem dono humano (vazio ou IA) segue a regra padrão", async () => {
    dealFindFirst.mockResolvedValue(null);
    expect(
      await resolveKeepDealOwner({ conversationId: "c1", contactId: "ct1", departmentId: "d1" }),
    ).toBe(false);
  });

  it("negócio que disparou já GANHO (WON) com dono humano → mantém o dono da venda", async () => {
    expect(
      await resolveKeepDealOwner({
        conversationId: "c1",
        contactId: "ct1",
        dealId: "deal_ganho",
        override: true,
      }),
    ).toBe(true);
    const where = dealFindFirst.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.owner).toEqual({ type: "HUMAN" });
    // O próprio negócio vale em qualquer status; os outros do contato, só abertos.
    expect(where.OR).toEqual([
      { id: "deal_ganho" },
      { contactId: "ct1", status: "OPEN" },
    ]);
  });

  it("negócio que disparou sem dono humano segue a regra padrão", async () => {
    dealFindFirst.mockResolvedValue(null);
    expect(
      await resolveKeepDealOwner({
        conversationId: "c1",
        contactId: "ct1",
        dealId: "deal_ia",
        override: true,
      }),
    ).toBe(false);
  });

  it("override do modal vence o departamento nos dois sentidos", async () => {
    departmentFindUnique.mockResolvedValue({ keepDealOwner: false });
    expect(
      await resolveKeepDealOwner({
        conversationId: "c1",
        contactId: "ct1",
        departmentId: "d1",
        override: true,
      }),
    ).toBe(true);
    departmentFindUnique.mockResolvedValue({ keepDealOwner: true });
    expect(
      await resolveKeepDealOwner({
        conversationId: "c1",
        contactId: "ct1",
        departmentId: "d1",
        override: false,
      }),
    ).toBe(false);
    expect(departmentFindUnique).not.toHaveBeenCalled();
  });

  it("departamento ausente = o da conversa", async () => {
    conversationFindUnique.mockResolvedValue({ contactId: "ct9", departmentId: "d_conv" });
    expect(await resolveKeepDealOwner({ conversationId: "c1" })).toBe(true);
    expect(departmentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d_conv" } }),
    );
    expect(dealFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ contactId: "ct9" }) }),
    );
  });
});

describe("assignConversationOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txConversationFindUnique.mockResolvedValue({
      id: "c1",
      contactId: "ct1",
      externalId: "#10",
      assignedToId: "vendedor",
      assignedTo: { name: "Vendedor" },
    });
    txUserFindUnique.mockResolvedValue({ name: "Financeiro", type: "HUMAN" });
    txConversationUpdate.mockResolvedValue({ id: "c1" });
  });

  it("troca só a conversa: não toca contato nem negócio", async () => {
    const change = await assignConversationOnly({ conversationId: "c1", userId: "fin" });

    expect(txConversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "c1" },
        data: expect.objectContaining({ assignedToId: "fin", routeMode: null }),
      }),
    );
    expect(txContactUpdate).not.toHaveBeenCalled();
    expect(txDealUpdateMany).not.toHaveBeenCalled();
    expect(change).toMatchObject({ fromUserId: "vendedor", toUserId: "fin", toName: "Financeiro" });
    // ASSIGNEE_CHANGED: sem ele o próximo inbound trata o atendente como herança.
    expect(logConversationAssigneeChanges).toHaveBeenCalledWith([change]);
  });

  it("remover o responsável mantém a rota pendente e não loga se nada mudou", async () => {
    txConversationFindUnique.mockResolvedValue({
      id: "c1",
      contactId: "ct1",
      externalId: null,
      assignedToId: null,
      assignedTo: null,
    });
    const change = await assignConversationOnly({ conversationId: "c1", userId: null });

    const data = txConversationUpdate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.assignedToId).toBeNull();
    expect("routeMode" in data).toBe(false);
    expect(change).toBeNull();
    expect(logConversationAssigneeChanges).not.toHaveBeenCalled();
  });
});
