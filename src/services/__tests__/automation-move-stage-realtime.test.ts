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
  h.dealUpdate.mockResolvedValue({ id: "deal-1" });
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
    stage: { name: "Novo", pipelineId: "pipe-1" },
  });
});

describe("automação move_stage", () => {
  it("depois do update, publica o deal aberto de A para B", async () => {
    await executeStep("move_stage", { stageId: "stage-b" }, rt);

    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledWith("deal-1", "stage-a");
    const updateOrder = h.dealUpdate.mock.invocationCallOrder[0]!;
    const publishOrder = h.publishActiveDealMoved.mock.invocationCallOrder[0]!;
    expect(publishOrder).toBeGreaterThan(updateOrder);
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
    h.dealFindUnique.mockResolvedValue({ stageId: "stage-a", contactId: "c1" });
    await executeStep("update_field", { entity: "deal", field: "stageId", value: "stage-b" }, rt);
    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.publishActiveDealMoved).toHaveBeenCalledWith("deal-1", "stage-a");
  });
});
