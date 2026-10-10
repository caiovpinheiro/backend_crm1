/**
 * Transferir/atribuir a conversa leva o dono dos negócios ABERTOS do contato
 * (regra inalterada). Antes, essa troca de dono não invalidava o cache do
 * board nem publicava evento: o card ficava com o responsável antigo até o
 * TTL/F5. Agora: cache dos funis afetados invalidado (uma vez por funil) e
 * `deal_moved` com o card novo por negócio, até `DEAL_MOVED_BATCH_LIMIT`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const tx = {
    conversation: { update: vi.fn() },
    contact: { update: vi.fn().mockResolvedValue({}) },
    deal: { findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    conversation: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    deal: { findMany: vi.fn() },
  };
  return {
    tx,
    prisma,
    invalidateBoardData: vi.fn().mockResolvedValue(undefined),
    ssePublish: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: h.prisma,
  allocateOrgNumber: vi.fn(),
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: h.ssePublish } }));
vi.mock("@/lib/cache", () => ({
  cache: {
    wrap: vi.fn(async (_k: string, _t: number, loader: () => Promise<unknown>) => loader()),
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    delPattern: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock("@/lib/cache/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache/keys")>()),
  invalidateBoardData: h.invalidateBoardData,
}));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  userIdForFk: (v: unknown) => v ?? null,
  withAutomationOriginMeta: (m: unknown) => m,
}));
vi.mock("@/services/analytics", () => ({ getStageMetrics: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: vi.fn().mockResolvedValue(true),
  getOrgSetting: vi.fn().mockResolvedValue(null),
  getOrgSettingFor: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/kanban-filters", () => ({
  buildDealWhereFromFilters: vi.fn().mockResolvedValue([]),
  buildDealSearchOr: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/loss-reasons", () => ({
  assertLostReasonAllowedForPipeline: vi.fn().mockResolvedValue(undefined),
  isPipelineLossReasonAllowOther: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/services/product-fulfillment", () => ({
  onDealWon: vi.fn(),
  onDealReverted: vi.fn(),
  onCandidateStageMove: vi.fn(),
}));
vi.mock("@/services/fulfillment", () => ({ onCommercialDealWon: vi.fn() }));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async (c: unknown[]) => c),
}));

import { runWithContext } from "@/lib/request-context";
import { assignConversationAssignedTo } from "@/services/conversations";
import { DEAL_MOVED_BATCH_LIMIT } from "@/services/deals";

const ORG = "org-a";
const ACTOR = { id: "admin-1", role: "ADMIN" as const, canReassignOthers: true };

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: ORG, userId: "admin-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

function openDeal(id: string, ownerId: string | null, pipelineId: string) {
  return { id, ownerId, stage: { pipelineId } };
}

/** Linha do UPDATE depois da troca (a mesma leitura que alimenta o card). */
function dealRow(id: string, pipelineId: string, ownerId: string) {
  return {
    id,
    title: `Negócio ${id}`,
    value: 100,
    status: "OPEN",
    lostReason: null,
    position: 2,
    expectedClose: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-07T12:00:00.000Z"),
    stageId: `stage-${pipelineId}`,
    ownerId,
    orgUnitId: null,
    contact: { id: "c1", name: "Cliente", email: null, phone: null, avatarUrl: null },
    owner: { id: ownerId, name: "Beto", avatarUrl: null, type: "HUMAN" },
    tags: [],
    stage: { pipelineId, isWon: false, isLost: false },
  };
}

function dealMovedEvents() {
  return h.ssePublish.mock.calls.filter((c) => c[0] === "deal_moved").map((c) => c[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.conversation.findUnique.mockResolvedValue({ assignedToId: "user-a" });
  h.prisma.user.findUnique.mockResolvedValue({ id: "user-b" });
  h.tx.conversation.update.mockResolvedValue({
    id: "conv-1",
    status: "OPEN",
    externalId: null,
    contactId: "c1",
    assignedToId: "user-b",
    contact: { id: "c1" },
    assignedTo: { id: "user-b", name: "Beto", type: "HUMAN" },
  });
});

describe("assignConversationAssignedTo — board dos negócios que trocaram de dono", () => {
  it("invalida o board de cada funil afetado (uma vez) e publica deal_moved por negócio com o card novo", async () => {
    h.tx.deal.findMany.mockResolvedValue([
      openDeal("d1", "user-a", "pipe-1"),
      openDeal("d2", "user-a", "pipe-1"),
      openDeal("d3", "user-a", "pipe-2"),
    ]);
    h.prisma.deal.findMany.mockResolvedValue([
      dealRow("d1", "pipe-1", "user-b"),
      dealRow("d2", "pipe-1", "user-b"),
      dealRow("d3", "pipe-2", "user-b"),
    ]);

    const res = await withOrg(() => assignConversationAssignedTo("conv-1", "user-b", ACTOR));
    expect(res.ok).toBe(true);

    // A regra de negócio segue igual: o dono dos negócios abertos vai junto.
    expect(h.tx.deal.updateMany).toHaveBeenCalledWith({
      where: { contactId: "c1", status: "OPEN" },
      data: { ownerId: "user-b", assignedVia: null },
    });

    // Cache: 1 invalidação por funil (não por negócio).
    expect(h.invalidateBoardData).toHaveBeenCalledTimes(2);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-2");

    // Evento: 1 por negócio, mesma etapa, card com o dono novo.
    const events = dealMovedEvents();
    expect(events.map((e) => e.dealId).sort()).toEqual(["d1", "d2", "d3"]);
    expect(events[0]).toMatchObject({
      organizationId: ORG,
      fromStageId: "stage-pipe-1",
      toStageId: "stage-pipe-1",
      fromPipelineId: "pipe-1",
      toPipelineId: "pipe-1",
      position: 2,
      card: { id: "d1", owner: { id: "user-b", name: "Beto" } },
    });
    // Invalida ANTES de publicar (o refetch do cliente não lê o board antigo).
    const lastInvalidate = Math.max(...h.invalidateBoardData.mock.invocationCallOrder);
    const firstPublish = Math.min(
      ...h.ssePublish.mock.invocationCallOrder.filter(
        (_o, i) => h.ssePublish.mock.calls[i][0] === "deal_moved",
      ),
    );
    expect(lastInvalidate).toBeLessThan(firstPublish);
  });

  it("negócio que já era do novo responsável não gera evento nem invalidação", async () => {
    h.tx.deal.findMany.mockResolvedValue([
      openDeal("d1", "user-b", "pipe-1"),
      openDeal("d2", "user-a", "pipe-2"),
    ]);
    h.prisma.deal.findMany.mockResolvedValue([dealRow("d2", "pipe-2", "user-b")]);

    await withOrg(() => assignConversationAssignedTo("conv-1", "user-b", ACTOR));

    expect(h.invalidateBoardData).toHaveBeenCalledTimes(1);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-2");
    expect(dealMovedEvents().map((e) => e.dealId)).toEqual(["d2"]);
  });

  it("contato sem negócio aberto: nada para o board", async () => {
    h.tx.deal.findMany.mockResolvedValue([]);

    await withOrg(() => assignConversationAssignedTo("conv-1", "user-b", ACTOR));

    expect(h.invalidateBoardData).not.toHaveBeenCalled();
    expect(dealMovedEvents()).toHaveLength(0);
    expect(h.prisma.deal.findMany).not.toHaveBeenCalled();
  });

  it("remover o responsável (null) também avisa o board", async () => {
    h.tx.conversation.update.mockResolvedValue({
      id: "conv-1",
      status: "OPEN",
      externalId: null,
      contactId: "c1",
      assignedToId: null,
      contact: { id: "c1" },
      assignedTo: null,
    });
    h.tx.deal.findMany.mockResolvedValue([openDeal("d1", "user-a", "pipe-1")]);
    h.prisma.deal.findMany.mockResolvedValue([
      { ...dealRow("d1", "pipe-1", "user-a"), ownerId: null, owner: null },
    ]);

    await withOrg(() => assignConversationAssignedTo("conv-1", null, ACTOR));

    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    expect(dealMovedEvents()).toHaveLength(1);
    expect(dealMovedEvents()[0].card.owner).toBeNull();
  });

  it(`acima de ${DEAL_MOVED_BATCH_LIMIT} negócios só invalida o board (sem um evento por card)`, async () => {
    const many = Array.from({ length: DEAL_MOVED_BATCH_LIMIT + 1 }, (_, i) =>
      openDeal(`d${i}`, "user-a", i % 2 === 0 ? "pipe-1" : "pipe-2"),
    );
    h.tx.deal.findMany.mockResolvedValue(many);

    await withOrg(() => assignConversationAssignedTo("conv-1", "user-b", ACTOR));

    expect(h.invalidateBoardData).toHaveBeenCalledTimes(2);
    expect(dealMovedEvents()).toHaveLength(0);
    expect(h.prisma.deal.findMany).not.toHaveBeenCalled();
  });

  it("falha de Redis na invalidação não desfaz a atribuição", async () => {
    h.tx.deal.findMany.mockResolvedValue([openDeal("d1", "user-a", "pipe-1")]);
    h.prisma.deal.findMany.mockResolvedValue([dealRow("d1", "pipe-1", "user-b")]);
    h.invalidateBoardData.mockRejectedValueOnce(new Error("redis fora"));

    const res = await withOrg(() => assignConversationAssignedTo("conv-1", "user-b", ACTOR));

    expect(res.ok).toBe(true);
  });
});
