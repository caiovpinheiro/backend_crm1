/**
 * Automação `move_stage` / `update_field` (etapa) / `mark_deal_won|lost`:
 * depois do update o board é avisado (cache invalidado + `deal_moved`) — para
 * qualquer destino, inclusive Ganho/Perdido, e também quando o passo move
 * vários negócios. Nada sai se o banco recusa a etapa.
 *
 * O helper `syncBoardsAfterDealChanges` (invalida por funil, publica até o teto
 * do lote) tem testes próprios em `deals-move-board.test.ts`.
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
    syncBoardsAfterDealChanges: vi.fn(),
    markDealWon: vi.fn(),
    markDealLost: vi.fn(),
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
  markDealLost: h.markDealLost,
  markDealWon: h.markDealWon,
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
    ownerId: true,
    orgUnitId: true,
    contact: {
      select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
    },
    owner: { select: { id: true, name: true, avatarUrl: true, type: true } },
    tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
    stage: { select: { pipelineId: true, isWon: true, isLost: true } },
  },
  syncBoardsAfterDealChanges: h.syncBoardsAfterDealChanges,
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
  fireTrigger: vi.fn(async () => undefined),
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

function syncArg(call = 0) {
  return h.syncBoardsAfterDealChanges.mock.calls[call]![0] as {
    changes: Array<{ dealId: string; fromStageId?: string; fromPipelineId?: string | null }>;
    rows: Map<string, { id: string; stageId: string; status: string }>;
    extraPipelineIds?: Array<string | undefined>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assertStageEntryFields.mockResolvedValue(undefined);
  h.createDealEvent.mockResolvedValue(undefined);
  h.syncBoardsAfterDealChanges.mockResolvedValue({ invalidatedPipelines: [], published: 0 });
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
  it("depois do update, avisa o board do deal aberto de A para B", async () => {
    await executeStep("move_stage", { stageId: "stage-b" }, rt);

    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    const arg = syncArg();
    expect(arg.changes).toEqual([
      { dealId: "deal-1", fromStageId: "stage-a", fromPipelineId: "pipe-1" },
    ]);
    expect(arg.rows.get("deal-1")).toEqual(
      expect.objectContaining({ id: "deal-1", stageId: "stage-b", status: "OPEN" }),
    );
    expect(arg.extraPipelineIds).toEqual(["pipe-1"]);
    const updateOrder = h.dealUpdate.mock.invocationCallOrder[0]!;
    const syncOrder = h.syncBoardsAfterDealChanges.mock.invocationCallOrder[0]!;
    expect(syncOrder).toBeGreaterThan(updateOrder);
  });

  it("mensagem recebida move Qualificado → Novo e avisa o board depois do update", async () => {
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
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    const arg = syncArg();
    expect(arg.changes).toEqual([
      { dealId: "deal-caio", fromStageId: "stage-qualificado", fromPipelineId: "pipe-1" },
    ]);
    expect(arg.rows.get("deal-caio")).toBe(saved);
    expect(h.syncBoardsAfterDealChanges.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.dealUpdate.mock.invocationCallOrder[0]!,
    );
  });

  it("passo que move vários negócios avisa o board UMA vez, com todos (o helper aplica o teto do lote)", async () => {
    h.dealFindUnique.mockImplementation(async () => ({
      status: "OPEN",
      stageId: "stage-qualificado",
      contactId: "c1",
      stage: { name: "Qualificado", pipelineId: "pipe-1", isWon: false, isLost: false },
    }));
    h.dealUpdate.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      title: args.where.id,
      status: "OPEN",
      stageId: "stage-novo",
      position: 1,
      stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
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
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(syncArg().changes.map((c) => c.dealId)).toEqual(["deal-caio", "deal-outro"]);
    expect([...syncArg().rows.keys()]).toEqual(["deal-caio", "deal-outro"]);
  });

  it("não avisa o board se a etapa destino recusa o deal", async () => {
    h.assertStageEntryFields.mockRejectedValue(
      new StageFieldsRequiredError("Contato", [{ id: "cf", label: "Curso" }]),
    );

    await expect(executeStep("move_stage", { stageId: "stage-b" }, rt)).rejects.toBeInstanceOf(
      StageFieldsRequiredError,
    );
    expect(h.dealUpdate).not.toHaveBeenCalled();
    expect(h.syncBoardsAfterDealChanges).not.toHaveBeenCalled();
  });

  it("mover para Ganho ou Perdido também invalida e avisa o board do funil", async () => {
    h.stageFindUnique.mockResolvedValue({
      id: "stage-won",
      name: "Ganho",
      isWon: true,
      isLost: false,
      pipelineId: "pipe-1",
    });
    h.dealUpdate.mockResolvedValue({
      id: "deal-1",
      status: "WON",
      stageId: "stage-won",
      position: 0,
      stage: { pipelineId: "pipe-1", isWon: true, isLost: false },
    });
    await executeStep("move_stage", { stageId: "stage-won" }, rt);
    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(syncArg().changes).toEqual([
      { dealId: "deal-1", fromStageId: "stage-a", fromPipelineId: "pipe-1" },
    ]);
    expect(syncArg().rows.get("deal-1")).toEqual(
      expect.objectContaining({ status: "WON", stageId: "stage-won" }),
    );

    h.dealUpdate.mockClear();
    h.syncBoardsAfterDealChanges.mockClear();
    h.stageFindUnique.mockResolvedValue({
      id: "stage-lost",
      name: "Perdido",
      isWon: false,
      isLost: true,
      pipelineId: "pipe-1",
    });
    h.dealUpdate.mockResolvedValue({
      id: "deal-1",
      status: "LOST",
      stageId: "stage-lost",
      position: 0,
      stage: { pipelineId: "pipe-1", isWon: false, isLost: true },
    });
    await executeStep("move_stage", { stageId: "stage-lost" }, rt);
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(syncArg().rows.get("deal-1")).toEqual(expect.objectContaining({ status: "LOST" }));
  });

  it("mover para o terminal de OUTRO funil purga os dois funis", async () => {
    h.stageFindUnique.mockResolvedValue({
      id: "stage-won-2",
      name: "Ganho",
      isWon: true,
      isLost: false,
      pipelineId: "pipe-2",
    });
    h.dealUpdate.mockResolvedValue({
      id: "deal-1",
      status: "WON",
      stageId: "stage-won-2",
      position: 0,
      stage: { pipelineId: "pipe-2", isWon: true, isLost: false },
    });

    await executeStep("move_stage", { stageId: "stage-won-2" }, rt);

    expect(syncArg().changes[0]).toMatchObject({ fromPipelineId: "pipe-1" });
    expect(syncArg().extraPipelineIds).toEqual(["pipe-2"]);
  });

  it("negócio que já estava na etapa destino não avisa o board", async () => {
    h.dealFindUnique.mockResolvedValue({
      status: "OPEN",
      stageId: "stage-b",
      contactId: "c1",
      stage: { name: "Contato", pipelineId: "pipe-1", isWon: false, isLost: false },
    });

    await executeStep("move_stage", { stageId: "stage-b" }, rt);

    expect(h.syncBoardsAfterDealChanges).not.toHaveBeenCalled();
  });

  it("update_field de stageId também avisa o board depois do update", async () => {
    h.dealFindUnique.mockResolvedValue({
      stageId: "stage-a",
      contactId: "c1",
      status: "OPEN",
      stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
    });
    await executeStep("update_field", { entity: "deal", field: "stageId", value: "stage-b" }, rt);
    expect(h.dealUpdate).toHaveBeenCalledTimes(1);
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(syncArg().changes).toEqual([
      { dealId: "deal-1", fromStageId: "stage-a", fromPipelineId: "pipe-1" },
    ]);
  });

  it("update_field de stageId para Ganho/Perdido também avisa (antes não invalidava nada)", async () => {
    h.dealFindUnique.mockResolvedValue({
      stageId: "stage-a",
      contactId: "c1",
      status: "OPEN",
      stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
    });
    h.dealUpdate.mockResolvedValue({
      id: "deal-1",
      status: "OPEN",
      stageId: "stage-won",
      position: 0,
      stage: { pipelineId: "pipe-1", isWon: true, isLost: false },
    });
    await executeStep("update_field", { entity: "deal", field: "stageId", value: "stage-won" }, rt);
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
  });
});

describe("automação mark_deal_won / mark_deal_lost", () => {
  it("mark_deal_won avisa o board (o cache já era invalidado pelo markDealWon)", async () => {
    h.dealFindUnique.mockResolvedValue({
      status: "OPEN",
      stageId: "stage-a",
      contactId: "c1",
      stage: { pipelineId: "pipe-1" },
    });
    const won = {
      id: "deal-1",
      status: "WON",
      stageId: "stage-won",
      position: 0,
      stage: { pipelineId: "pipe-1" },
    };
    h.markDealWon.mockResolvedValue(won);

    await executeStep("mark_deal_won", { pipelineId: "pipe-1" }, rt);

    expect(h.markDealWon).toHaveBeenCalledWith("deal-1", { pipelineId: "pipe-1" });
    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(syncArg().changes).toEqual([
      { dealId: "deal-1", fromStageId: "stage-a", fromPipelineId: "pipe-1" },
    ]);
    expect(syncArg().rows.get("deal-1")).toBe(won);
  });

  it("mark_deal_lost avisa o board", async () => {
    h.dealFindUnique.mockResolvedValue({
      status: "OPEN",
      stageId: "stage-a",
      contactId: "c1",
      stage: { pipelineId: "pipe-1" },
    });
    h.markDealLost.mockResolvedValue({
      id: "deal-1",
      status: "LOST",
      stageId: "stage-lost",
      position: 0,
      stage: { pipelineId: "pipe-1" },
    });

    await executeStep("mark_deal_lost", { pipelineId: "pipe-1", lostReason: "Preço" }, rt);

    expect(h.syncBoardsAfterDealChanges).toHaveBeenCalledTimes(1);
    expect(syncArg().rows.get("deal-1")).toEqual(expect.objectContaining({ status: "LOST" }));
  });
});
