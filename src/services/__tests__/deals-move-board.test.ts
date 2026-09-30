/**
 * `services/deals` — núcleo do funil sem Postgres (CL-15).
 *
 * Cobre:
 *  - `moveDeal`: não toca em conversa ao mudar de etapa (inclusive Ganho/
 *    Perdido), recusa entrada com campo obrigatório vazio
 *    (`StageFieldsRequiredError`), invalida o board de origem E destino,
 *    sincroniza `status/closedAt` com a etapa, exige motivo de perda.
 *  - `nextDealNumber`: delega no contador atômico da org do contexto.
 *  - `resolveBoardDealIds` / `getBoardData`: `where` de visibilidade
 *    (status OPEN por padrão, `ownerId`, escopo do pipeline) e chave de
 *    cache por org.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "deal-1" }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    deal: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    stage: { findUnique: vi.fn() },
    pipeline: { findUnique: vi.fn().mockResolvedValue({ lossReasonRequired: false }) },
    conversation: { update: vi.fn(), updateMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    deal: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn(),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    stage: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    customField: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { update: vi.fn(), updateMany: vi.fn() },
  };
  return {
    tx,
    prisma,
    allocateOrgNumber: vi.fn().mockResolvedValue(42),
    invalidateBoardData: vi.fn().mockResolvedValue(undefined),
    cacheWrap: vi.fn(
      async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
    ),
    ssePublish: vi.fn(),
    onCandidateStageMove: vi.fn().mockResolvedValue(undefined),
    onDealWon: vi.fn().mockResolvedValue(undefined),
    onDealReverted: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: h.prisma,
  allocateOrgNumber: h.allocateOrgNumber,
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: h.ssePublish } }));
vi.mock("@/lib/cache", () => ({
  cache: {
    wrap: h.cacheWrap,
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
vi.mock("@/services/analytics", () => ({
  getStageMetrics: vi.fn().mockResolvedValue([]),
}));
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
  onDealWon: h.onDealWon,
  onDealReverted: h.onDealReverted,
  onCandidateStageMove: h.onCandidateStageMove,
}));
vi.mock("@/services/fulfillment", () => ({
  onCommercialDealWon: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async (c: unknown[]) => c),
}));

import { runWithContext } from "@/lib/request-context";
import {
  getBoardData,
  moveDeal,
  nextDealNumber,
  resolveBoardDealIds,
  StageFieldsRequiredError,
} from "@/services/deals";

const ORG = "org-a";

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

type StageRow = {
  id: string;
  pipelineId: string;
  isWon: boolean;
  isLost: boolean;
  name?: string;
  requiredDealFieldIds?: string[];
};

const STAGES: Record<string, StageRow> = {
  "stage-a": { id: "stage-a", pipelineId: "pipe-1", isWon: false, isLost: false, name: "Novo" },
  "stage-b": { id: "stage-b", pipelineId: "pipe-1", isWon: false, isLost: false, name: "Contato" },
  "stage-won": { id: "stage-won", pipelineId: "pipe-1", isWon: true, isLost: false, name: "Ganho" },
  "stage-lost": { id: "stage-lost", pipelineId: "pipe-1", isWon: false, isLost: true, name: "Perdido" },
  "stage-x": { id: "stage-x", pipelineId: "pipe-2", isWon: false, isLost: false, name: "Outro funil" },
  "stage-req": {
    id: "stage-req",
    pipelineId: "pipe-1",
    isWon: false,
    isLost: false,
    name: "Matrícula",
    requiredDealFieldIds: ["cf-curso"],
  },
};

function stageLookup(args: { where: { id: string } }) {
  const s = STAGES[args.where.id];
  return Promise.resolve(s ? { ...s, requiredDealFieldIds: s.requiredDealFieldIds ?? [] } : null);
}

/** Deal em `stageId` com status informado (default OPEN). */
function seedDeal(stageId: string, status: "OPEN" | "WON" | "LOST" = "OPEN") {
  const peek = { id: "deal-1", stage: { pipelineId: STAGES[stageId]!.pipelineId } };
  h.prisma.deal.findUnique.mockImplementation(async (args: { select?: unknown }) =>
    args.select && (args.select as { customFields?: unknown }).customFields
      ? { stageId, customFields: [] }
      : { ...peek, stageId, position: 0, status },
  );
  h.tx.deal.findUnique.mockResolvedValue({ id: "deal-1", stageId, position: 0, status });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.stage.findUnique.mockImplementation(stageLookup);
  h.tx.stage.findUnique.mockImplementation(stageLookup);
  h.tx.pipeline.findUnique.mockResolvedValue({ lossReasonRequired: false });
  h.tx.deal.count.mockResolvedValue(0);
  h.tx.deal.findMany.mockResolvedValue([]);
  h.tx.deal.update.mockResolvedValue({});
  h.prisma.customField.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("moveDeal", () => {
  it("muda a etapa sem encerrar nem tocar na conversa do contato", async () => {
    seedDeal("stage-a");
    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));

    expect(h.tx.deal.update).toHaveBeenCalledTimes(1);
    expect(h.tx.deal.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "deal-1" },
      data: { stageId: "stage-b", position: 0 },
    });
    // Regra "Nunca": mover card não encerra ticket.
    expect(h.tx.conversation.update).not.toHaveBeenCalled();
    expect(h.tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.conversation.update).not.toHaveBeenCalled();
    expect(h.prisma.conversation.updateMany).not.toHaveBeenCalled();
    const sseEvents = h.ssePublish.mock.calls.map((c) => c[0]);
    expect(sseEvents).not.toContain("conversation_updated");
  });

  it("mover para Ganho sincroniza status WON + closedAt, mas continua sem mexer na conversa", async () => {
    seedDeal("stage-a");
    await withOrg(ORG, () => moveDeal("deal-1", "stage-won", 0));

    const data = h.tx.deal.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.stageId).toBe("stage-won");
    expect(data.status).toBe("WON");
    expect(data.closedAt).toBeInstanceOf(Date);
    expect(data.lostReason).toBeNull();
    expect(h.tx.conversation.update).not.toHaveBeenCalled();
    expect(h.prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("reabrir (Ganho → etapa comum) volta status OPEN e limpa closedAt", async () => {
    seedDeal("stage-won", "WON");
    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    const data = h.tx.deal.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ stageId: "stage-b", status: "OPEN", closedAt: null, lostReason: null });
  });

  it("recusa entrada em etapa com campo obrigatório vazio (StageFieldsRequiredError) sem abrir transação", async () => {
    seedDeal("stage-a");
    h.prisma.customField.findMany.mockResolvedValue([
      { id: "cf-curso", label: "Curso", name: "curso", type: "TEXT" },
    ]);

    await expect(
      withOrg(ORG, () => moveDeal("deal-1", "stage-req", 0)),
    ).rejects.toMatchObject({
      name: "StageFieldsRequiredError",
      stageName: "Matrícula",
      fields: [{ id: "cf-curso", label: "Curso" }],
    });
    await expect(
      withOrg(ORG, () => moveDeal("deal-1", "stage-req", 0)),
    ).rejects.toBeInstanceOf(StageFieldsRequiredError);

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.deal.update).not.toHaveBeenCalled();
    expect(h.invalidateBoardData).not.toHaveBeenCalled();
  });

  it("deixa entrar na etapa com campo obrigatório quando ele está preenchido", async () => {
    seedDeal("stage-a");
    h.prisma.deal.findUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select && (args.select as { customFields?: unknown }).customFields
        ? { stageId: "stage-a", customFields: [{ customFieldId: "cf-curso", value: "ADS" }] }
        : { id: "deal-1", stage: { pipelineId: "pipe-1" }, stageId: "stage-a", position: 0, status: "OPEN" },
    );
    h.prisma.customField.findMany.mockResolvedValue([
      { id: "cf-curso", label: "Curso", name: "curso", type: "TEXT" },
    ]);

    await withOrg(ORG, () => moveDeal("deal-1", "stage-req", 0));
    expect(h.tx.deal.update).toHaveBeenCalledTimes(1);
  });

  it("invalida o board do pipeline (uma vez) quando origem e destino são o mesmo funil", async () => {
    seedDeal("stage-a");
    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    // fire-and-forget: espera o microtask do `void invalidateBoardData`.
    await Promise.resolve();

    expect(h.invalidateBoardData).toHaveBeenCalledTimes(1);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
  });

  it("invalida o board de ORIGEM e de DESTINO no move entre funis, sempre na org do contexto", async () => {
    seedDeal("stage-a");
    await withOrg(ORG, () => moveDeal("deal-1", "stage-x", 0));
    await Promise.resolve();

    expect(h.invalidateBoardData).toHaveBeenCalledTimes(2);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-2");
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    for (const call of h.invalidateBoardData.mock.calls) {
      expect(call[0]).toBe(ORG);
    }
  });

  it("exige motivo de perda quando o funil do destino obriga (LOST_REASON_REQUIRED)", async () => {
    seedDeal("stage-a");
    h.tx.pipeline.findUnique.mockResolvedValue({ lossReasonRequired: true });

    await expect(
      withOrg(ORG, () => moveDeal("deal-1", "stage-lost", 0)),
    ).rejects.toThrow("LOST_REASON_REQUIRED");
    expect(h.tx.deal.update).not.toHaveBeenCalled();

    await withOrg(ORG, () => moveDeal("deal-1", "stage-lost", 0, { lostReason: "Sem interesse" }));
    const data = h.tx.deal.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ status: "LOST", lostReason: "Sem interesse" });
    expect(data.closedAt).toBeInstanceOf(Date);
  });

  it("valida a posição antes de qualquer leitura", async () => {
    await expect(withOrg(ORG, () => moveDeal("deal-1", "stage-b", -1))).rejects.toThrow(
      "INVALID_POSITION",
    );
    await expect(withOrg(ORG, () => moveDeal("deal-1", "stage-b", 1.5))).rejects.toThrow(
      "INVALID_POSITION",
    );
    expect(h.prisma.deal.findUnique).not.toHaveBeenCalled();
  });

  it("NOT_FOUND / STAGE_NOT_FOUND antes da transação", async () => {
    h.prisma.deal.findUnique.mockResolvedValue(null);
    await expect(withOrg(ORG, () => moveDeal("nope", "stage-b", 0))).rejects.toThrow("NOT_FOUND");

    seedDeal("stage-a");
    await expect(withOrg(ORG, () => moveDeal("deal-1", "stage-404", 0))).rejects.toThrow(
      "STAGE_NOT_FOUND",
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("reordenar dentro da mesma etapa não muda stageId nem status", async () => {
    seedDeal("stage-a");
    h.tx.deal.count.mockResolvedValue(3);
    h.tx.deal.findMany.mockResolvedValue([{ position: 1 }, { position: 2 }]);

    await withOrg(ORG, () => moveDeal("deal-1", "stage-a", 2));
    const data = h.tx.deal.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("stageId");
    expect(data).not.toHaveProperty("status");
    // ponto médio entre os vizinhos 1 e 2
    expect(data.position).toBe(1.5);
  });

  it("retenta em deadlock (P2034) e desiste em erro comum", async () => {
    vi.useFakeTimers();
    seedDeal("stage-a");
    h.tx.deal.update
      .mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "P2034" }))
      .mockResolvedValueOnce({});

    const p = withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    await vi.runAllTimersAsync();
    await p;
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);

    h.prisma.$transaction.mockClear();
    h.tx.deal.update.mockRejectedValueOnce(new Error("boom"));
    await expect(withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0))).rejects.toThrow("boom");
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("nextDealNumber", () => {
  it("aloca no contador atômico do model Deal da org do contexto", async () => {
    h.allocateOrgNumber.mockResolvedValueOnce(1234);
    await expect(withOrg("org-z", () => nextDealNumber())).resolves.toBe(1234);
    expect(h.allocateOrgNumber).toHaveBeenCalledWith("Deal", "org-z");
  });

  it("explode fora de contexto de org (nunca numera sem tenant)", async () => {
    await expect(nextDealNumber()).rejects.toThrow(/organization context ausente/);
    expect(h.allocateOrgNumber).not.toHaveBeenCalled();
  });
});

describe("resolveBoardDealIds — where de visibilidade", () => {
  function lastWhere() {
    const call = h.prisma.deal.findMany.mock.calls.at(-1)![0] as {
      where: Record<string, unknown>;
      take: number;
    };
    return call;
  }

  it("por padrão só OPEN + escopo do pipeline", async () => {
    await withOrg(ORG, () => resolveBoardDealIds("pipe-1"));
    const { where } = lastWhere();
    expect(where).toEqual({
      AND: [{ status: "OPEN" }, { stage: { is: { pipelineId: "pipe-1" } } }],
    });
  });

  it("visibilityOwnerId restringe ao responsável; statusFilter ALL tira o status", async () => {
    await withOrg(ORG, () =>
      resolveBoardDealIds("pipe-1", { visibilityOwnerId: "user-9", statusFilter: "ALL" }),
    );
    const { where } = lastWhere();
    expect(where.AND).toEqual([
      { ownerId: "user-9" },
      { stage: { is: { pipelineId: "pipe-1" } } },
    ]);
  });

  it("stageId escopa etapa E pipeline (não aceita etapa de outro funil)", async () => {
    await withOrg(ORG, () =>
      resolveBoardDealIds("pipe-1", { stageId: "stage-a", statusFilter: "WON", extraWhere: { title: "x" } }),
    );
    const { where } = lastWhere();
    expect(where.AND).toEqual([
      { status: "WON" },
      { title: "x" },
      { stageId: "stage-a", stage: { is: { pipelineId: "pipe-1" } } },
    ]);
  });

  it("cap: lê cap+1 e sinaliza `capped`", async () => {
    h.prisma.deal.findMany.mockResolvedValueOnce([{ id: "1" }, { id: "2" }, { id: "3" }]);
    const out = await withOrg(ORG, () => resolveBoardDealIds("pipe-1", { cap: 2 }));
    expect(lastWhere().take).toBe(3);
    expect(out).toEqual({ ids: ["1", "2"], capped: true });
  });
});

describe("getBoardData — cache por org e where de visibilidade", () => {
  it("chave de cache carrega a org do contexto e o pipeline; a mesma variante em outra org é outra chave", async () => {
    await withOrg("org-a", () => getBoardData("pipe-1", { ownerId: "u1" }));
    await withOrg("org-b", () => getBoardData("pipe-1", { ownerId: "u1" }));

    const keys = h.cacheWrap.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toMatch(/^board:org-a:pipe-1:/);
    expect(keys[1]).toMatch(/^board:org-b:pipe-1:/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("aplica visibilidade (string legada vira ownerId) + status OPEN + pipeline no COUNT por etapa", async () => {
    await withOrg(ORG, () => getBoardData("pipe-1", "user-7"));
    const groupBy = h.prisma.deal.groupBy.mock.calls.at(-1)![0] as { where: unknown };
    expect(groupBy.where).toEqual({
      AND: [{ status: "OPEN" }, { ownerId: "user-7" }],
      stage: { pipelineId: "pipe-1" },
    });
  });

  it("statusFilter ALL sem visibilidade: só o escopo do pipeline", async () => {
    await withOrg(ORG, () => getBoardData("pipe-1", null, "ALL"));
    const groupBy = h.prisma.deal.groupBy.mock.calls.at(-1)![0] as { where: unknown };
    expect(groupBy.where).toEqual({ stage: { pipelineId: "pipe-1" } });
  });

  it("cards de cada etapa são lidos com o MESMO where de visibilidade", async () => {
    h.prisma.stage.findMany.mockResolvedValueOnce([
      { id: "stage-a", pipelineId: "pipe-1", position: 0, isWon: false, isLost: false, rottingDays: 7 },
    ]);
    await withOrg(ORG, () => getBoardData("pipe-1", { ownerId: "u1" }));
    const dealsCall = h.prisma.deal.findMany.mock.calls.find(
      (c) => (c[0] as { where: { stageId?: string } }).where.stageId === "stage-a",
    );
    expect(dealsCall).toBeDefined();
    expect((dealsCall![0] as { where: unknown }).where).toEqual({
      AND: [{ status: "OPEN" }, { ownerId: "u1" }],
      stageId: "stage-a",
    });
  });

  it("fora de contexto de org não consulta nada", async () => {
    await expect(getBoardData("pipe-1")).rejects.toThrow(/organization context ausente/);
    expect(h.cacheWrap).not.toHaveBeenCalled();
    expect(h.prisma.deal.groupBy).not.toHaveBeenCalled();
  });
});
