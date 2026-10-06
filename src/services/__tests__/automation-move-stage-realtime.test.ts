/**
 * Automação `move_stage`: publica `deal_moved` só depois do update,
 * e não publica se o banco recusa a etapa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    stageFindUnique: vi.fn(),
    dealFindUnique: vi.fn(),
    dealFindFirst: vi.fn(),
    dealUpdate: vi.fn(),
    assertStageEntryFields: vi.fn(),
    createDealEvent: vi.fn(),
    publishActiveDealMoved: vi.fn(),
    notifyDealStageChanged: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    stage: { findUnique: h.stageFindUnique },
    deal: {
      findUnique: h.dealFindUnique,
      findFirst: h.dealFindFirst,
      update: h.dealUpdate,
    },
  },
}));
vi.mock("@/services/deals", () => ({
  assertStageEntryFields: h.assertStageEntryFields,
  assignDealOwner: vi.fn(),
  createDealEvent: h.createDealEvent,
  markDealLost: vi.fn(),
  markDealWon: vi.fn(),
    activeDealMovedSelect: {
      id: true,
      title: true,
      value: true,
      status: true,
      lostReason: true,
      position: true,
      expectedClose: true,
      createdAt: true,
      updatedAt: true,
      stageId: true,
      contact: {
        select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
      },
      owner: { select: { id: true, name: true, avatarUrl: true, type: true } },
      tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
      stage: { select: { pipelineId: true, isWon: true, isLost: true } },
    },
    publishActiveDealMoved: h.publishActiveDealMoved,
  findCanonicalOpenDealInPipeline: vi.fn(),
  nextDealNumber: vi.fn(),
  propagateOwnerToContactAndChat: vi.fn(),
  StageFieldsRequiredError: class StageFieldsRequiredError extends Error {
    stageName: string;
    fields: { id: string; label: string }[];
    constructor(stageName: string, fields: { id: string; label: string }[]) {
      super(stageName);
      this.name = "StageFieldsRequiredError";
      this.stageName = stageName;
      this.fields = fields;
    }
  },
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(),
  notifyDealStageChanged: h.notifyDealStageChanged,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

import { StageFieldsRequiredError } from "@/services/deals";
import { executeStep } from "@/services/automation-executor";

const rt = {
  automationId: "auto-1",
  automationName: "Fluxo",
  contactId: "c1",
  dealId: "deal-1",
  event: "manual",
  data: {},
  contact: null,
  deal: null,
  conversation: null,
  contactTagIds: [],
  contactTagNames: [],
  dealTagIds: [],
  dealTagNames: [],
  contactCustomFields: {},
  dealCustomFields: {},
  depth: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertStageEntryFields.mockResolvedValue(undefined);
  h.createDealEvent.mockResolvedValue(undefined);
  h.dealUpdate.mockResolvedValue({
    id: "deal-1",
    title: "Lead",
    status: "OPEN",
    stageId: "stage-b",
    position: 3,
    updatedAt: new Date("2026-10-06T12:00:01.000Z"),
    stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
  });
  h.stageFindUnique.mockResolvedValue({
    id: "stage-b",
    name: "Contato",
    isWon: false,
    isLost: false,
    pipelineId: "pipe-1",
  });
  h.dealFindUnique.mockResolvedValue({
    status: "OPEN",
    stageId: "stage-a",
    contactId: "c1",
    stage: { name: "Novo", pipelineId: "pipe-1", isWon: false, isLost: false },
  });
});

describe("automação move_stage", () => {
  it("depois do update, publica o deal aberto de A para B", async () => {
    await executeStep("move_stage", { stageId: "stage-b" }, rt);

    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledWith({
      dealId: "deal-1",
      fromStageId: "stage-a",
      fromPipelineId: "pipe-1",
      deal: expect.objectContaining({ id: "deal-1", stageId: "stage-b", status: "OPEN" }),
    });
    const updateOrder = h.dealUpdate.mock.invocationCallOrder[0]!;
    const publishOrder = h.publishActiveDealMoved.mock.invocationCallOrder[0]!;
    expect(publishOrder).toBeGreaterThan(updateOrder);
  });

  it("mensagem recebida move Qualificado → Novo e publica deal_moved depois do update", async () => {
    const saved = {
      id: "deal-caio",
      title: "Caio",
      status: "OPEN",
      stageId: "stage-novo",
      position: 4,
      updatedAt: new Date("2026-10-06T15:00:00.000Z"),
      stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
    };
    h.dealUpdate.mockResolvedValue(saved);
    h.stageFindUnique.mockResolvedValue({
      id: "stage-novo",
      name: "Novo",
      isWon: false,
      isLost: false,
      pipelineId: "pipe-1",
    });
    h.dealFindUnique.mockResolvedValue({
      status: "OPEN",
      stageId: "stage-qualificado",
      contactId: "c-caio",
      stage: { name: "Qualificado", pipelineId: "pipe-1", isWon: false, isLost: false },
    });

    await executeStep(
      "move_stage",
      { stageId: "stage-novo" },
      {
        ...rt,
        dealId: "deal-caio",
        event: "message_received",
        data: { stageMatchedDealIds: ["deal-caio"] },
      },
    );

    expect(h.dealUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "deal-caio" },
        data: { stageId: "stage-novo" },
      }),
    );
    expect(h.publishActiveDealMoved).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledWith({
      dealId: "deal-caio",
      fromStageId: "stage-qualificado",
      fromPipelineId: "pipe-1",
      deal: saved,
    });
    const updateOrder = h.dealUpdate.mock.invocationCallOrder[0]!;
    const publishOrder = h.publishActiveDealMoved.mock.invocationCallOrder[0]!;
    expect(publishOrder).toBeGreaterThan(updateOrder);
  });

  it("mensagem recebida que move vários negócios não publica deal_moved", async () => {
    h.dealFindUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      status: "OPEN",
      stageId: "stage-qualificado",
      contactId: "c1",
      stage: { name: "Qualificado", pipelineId: "pipe-1", isWon: false, isLost: false },
      id: args.where.id,
    }));

    await executeStep(
      "move_stage",
      { stageId: "stage-novo" },
      {
        ...rt,
        event: "message_received",
        data: { stageMatchedDealIds: ["deal-caio", "deal-outro"] },
      },
    );

    expect(h.dealUpdate).toHaveBeenCalledTimes(2);
    expect(h.publishActiveDealMoved).not.toHaveBeenCalled();
  });

  it("não publica se a etapa destino recusa o deal", async () => {
    h.assertStageEntryFields.mockRejectedValue(
      new StageFieldsRequiredError("Contato", [{ id: "cf", label: "Curso" }]),
    );

    await expect(executeStep("move_stage", { stageId: "stage-b" }, rt)).rejects.toBeInstanceOf(
      StageFieldsRequiredError,
    );
    expect(h.dealUpdate).not.toHaveBeenCalled();
    expect(h.publishActiveDealMoved).not.toHaveBeenCalled();
  });

  it("não publica ao mover para Ganho ou Perdido", async () => {
    h.stageFindUnique.mockResolvedValue({
      id: "stage-won",
      name: "Ganho",
      isWon: true,
      isLost: false,
      pipelineId: "pipe-1",
    });
    await executeStep("move_stage", { stageId: "stage-won" }, rt);
    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).not.toHaveBeenCalled();

    h.dealUpdate.mockClear();
    h.stageFindUnique.mockResolvedValue({
      id: "stage-lost",
      name: "Perdido",
      isWon: false,
      isLost: true,
      pipelineId: "pipe-1",
    });
    await executeStep("move_stage", { stageId: "stage-lost" }, rt);
    expect(h.publishActiveDealMoved).not.toHaveBeenCalled();
  });

  it("update_field de stageId também publica depois do update", async () => {
    h.dealFindUnique.mockResolvedValue({
      stageId: "stage-a",
      contactId: "c1",
      status: "OPEN",
      stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
    });
    await executeStep("update_field", { entity: "deal", field: "stageId", value: "stage-b" }, rt);
    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: "deal-1",
        fromStageId: "stage-a",
        fromPipelineId: "pipe-1",
      }),
    );
  });
});
