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
 *    (status OPEN por padrão, `ownerId`, escopo do pipeline), chave de
 *    cache por org e cards de todas as etapas numa única consulta
 *    ranqueada com o mesmo `where`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

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
  DEAL_MOVED_BATCH_LIMIT,
  getBoardData,
  moveDeal,
  nextDealNumber,
  resolveBoardDealIds,
  syncBoardsAfterDealChanges,
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

/**
 * `$queryRaw` recebe um `Prisma.Sql` (janela ranqueada do board) ou um
 * template literal (`strings, ...values`); só o primeiro tem `.strings`
 * como propriedade. Casa apenas a janela `ROW_NUMBER() OVER (...)`.
 */
function isRankedWindowSql(arg: unknown): arg is Prisma.Sql {
  if (Array.isArray(arg) || typeof arg !== "object" || arg === null) return false;
  const strings = (arg as { strings?: unknown }).strings;
  // A prévia do card também tem uma janela (por contato); a do board
  // particiona por etapa.
  return Array.isArray(strings) && strings.join("?").includes('PARTITION BY d."stageId"');
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

async function flushMovePublish() {
  await Promise.resolve();
  await Promise.resolve();
}

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
    await flushMovePublish();
    const sseEvents = h.ssePublish.mock.calls.map((c) => c[0]);
    expect(sseEvents).not.toContain("conversation_updated");
    expect(sseEvents).toEqual(["deal_moved"]);
    expect(h.ssePublish.mock.calls[0]![1]).toMatchObject({
      dealId: "deal-1",
      organizationId: ORG,
      fromPipelineId: "pipe-1",
      toPipelineId: "pipe-1",
      fromStageId: "stage-a",
      toStageId: "stage-b",
      position: 0,
    });
    expect(typeof (h.ssePublish.mock.calls[0]![1] as { updatedAt: string }).updatedAt).toBe(
      "string",
    );
  });

  it("o deal_moved leva ownerId e orgUnitId do negócio (a rota SSE filtra o card por dono)", async () => {
    seedDeal("stage-a");
    const base = h.prisma.deal.findUnique.getMockImplementation()!;
    h.prisma.deal.findUnique.mockImplementation(async (args: { select?: unknown }) => {
      const row = await base(args);
      // Leitura final do move (include): linha completa do negócio.
      return args.select
        ? row
        : { ...row, title: "Lead", ownerId: "user-7", orgUnitId: "unit-1", owner: { id: "user-7", name: "Ana" } };
    });

    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    await flushMovePublish();

    expect(h.ssePublish.mock.calls[0]![0]).toBe("deal_moved");
    expect(h.ssePublish.mock.calls[0]![1]).toMatchObject({
      dealId: "deal-1",
      ownerId: "user-7",
      orgUnitId: "unit-1",
      card: { id: "deal-1", owner: { id: "user-7" } },
    });
  });

  it("negócio sem dono publica ownerId null (e sem a linha, o campo some)", async () => {
    seedDeal("stage-a");
    const base = h.prisma.deal.findUnique.getMockImplementation()!;
    h.prisma.deal.findUnique.mockImplementation(async (args: { select?: unknown }) => {
      const row = await base(args);
      return args.select ? row : { ...row, title: "Lead", ownerId: null, owner: null };
    });
    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    await flushMovePublish();
    expect(h.ssePublish.mock.calls[0]![1]).toHaveProperty("ownerId", null);
    expect(h.ssePublish.mock.calls[0]![1]).not.toHaveProperty("orgUnitId");

    // Linha sem informação de dono: não inventa "sem dono".
    h.ssePublish.mockClear();
    seedDeal("stage-a");
    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    await flushMovePublish();
    expect(h.ssePublish.mock.calls[0]![1]).not.toHaveProperty("ownerId");
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
    await flushMovePublish();
    expect(h.ssePublish).not.toHaveBeenCalled();
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
    await flushMovePublish();
    expect(h.ssePublish).toHaveBeenCalledTimes(1);
    const invalidateOrder = h.invalidateBoardData.mock.invocationCallOrder[0]!;
    const publishOrder = h.ssePublish.mock.invocationCallOrder[0]!;
    expect(invalidateOrder).toBeLessThan(publishOrder);
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
    await flushMovePublish();
    expect(h.ssePublish.mock.calls[0]![1]).toMatchObject({
      organizationId: ORG,
      fromPipelineId: "pipe-1",
      toPipelineId: "pipe-2",
      fromStageId: "stage-a",
      toStageId: "stage-x",
    });
  });

  it("exige motivo de perda quando o funil do destino obriga (LOST_REASON_REQUIRED)", async () => {
    seedDeal("stage-a");
    h.tx.pipeline.findUnique.mockResolvedValue({ lossReasonRequired: true });

    await expect(
      withOrg(ORG, () => moveDeal("deal-1", "stage-lost", 0)),
    ).rejects.toThrow("LOST_REASON_REQUIRED");
    expect(h.tx.deal.update).not.toHaveBeenCalled();
    await flushMovePublish();
    expect(h.ssePublish).not.toHaveBeenCalled();

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
    await flushMovePublish();
    expect(h.ssePublish).toHaveBeenCalledTimes(1);

    h.prisma.$transaction.mockClear();
    h.ssePublish.mockClear();
    h.tx.deal.update.mockRejectedValueOnce(new Error("boom"));
    await expect(withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0))).rejects.toThrow("boom");
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    await flushMovePublish();
    expect(h.ssePublish).not.toHaveBeenCalled();
  });

  it("falha ao publicar deal_moved não desfaz o move", async () => {
    seedDeal("stage-a");
    h.ssePublish.mockImplementationOnce(() => {
      throw new Error("redis fora");
    });
    await expect(withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0))).resolves.toBeTruthy();
    await flushMovePublish();
    expect(h.tx.deal.update).toHaveBeenCalledTimes(1);
  });

  it("invalidate do board que falha ainda publica deal_moved", async () => {
    seedDeal("stage-a");
    h.invalidateBoardData.mockRejectedValueOnce(new Error("redis fora"));
    await withOrg(ORG, () => moveDeal("deal-1", "stage-b", 0));
    await flushMovePublish();
    expect(h.ssePublish).toHaveBeenCalledTimes(1);
    expect(h.ssePublish.mock.calls[0]![0]).toBe("deal_moved");
  });

  it("o evento sai com a organizationId do contexto, não de outra org", async () => {
    seedDeal("stage-a");
    await withOrg("org-z", () => moveDeal("deal-1", "stage-b", 0));
    await flushMovePublish();
    expect(h.ssePublish.mock.calls[0]![1]).toMatchObject({ organizationId: "org-z" });
    expect(h.invalidateBoardData).toHaveBeenCalledWith("org-z", "pipe-1");
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

  // A contagem por etapa sai da MESMA janela dos cards (K3): o where de
  // visibilidade que filtra os cards é, por construção, o que conta o total.
  const oneStageBoard = (total: number) => {
    h.prisma.stage.findMany.mockResolvedValueOnce([
      { id: "stage-a", pipelineId: "pipe-1", position: 0, isWon: false, isLost: false, rottingDays: 7 },
    ]);
    h.prisma.$queryRaw.mockImplementation(async (first: unknown) =>
      isRankedWindowSql(first) ? [{ id: "deal-a1", stageId: "stage-a", rn: 1, total }] : [],
    );
    h.prisma.deal.findMany.mockResolvedValueOnce([
      { id: "deal-a1", stageId: "stage-a", contactId: null, contact: null, updatedAt: new Date(), tags: [], activities: [] },
    ]);
  };
  const rankedCall = () => {
    const ranked = h.prisma.$queryRaw.mock.calls.map((c) => c[0]).filter(isRankedWindowSql);
    expect(ranked).toHaveLength(1);
    return { text: ranked[0]!.strings.join("?").replace(/\s+/g, " "), values: ranked[0]!.values };
  };

  it("aplica visibilidade (string legada vira ownerId) + status OPEN + etapas do funil no total por etapa", async () => {
    oneStageBoard(7);
    const out = await withOrg(ORG, () => getBoardData("pipe-1", "user-7"));
    const { text, values } = rankedCall();
    expect(text).toContain('COUNT(*) OVER (PARTITION BY d."stageId")::int AS total');
    expect(text).toContain(
      'WHERE d."organizationId" = ? AND d."stageId" = ANY(?) AND ((d."status" = ?::"DealStatus" AND d."ownerId" = ?))',
    );
    expect(values).toEqual([ORG, ["stage-a"], "OPEN", "user-7", expect.any(Number)]);
    // Nenhuma contagem à parte.
    expect(h.prisma.deal.groupBy).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ id: "stage-a", totalCount: 7, loadedCount: 1, hasMore: true });
    h.prisma.$queryRaw.mockReset().mockResolvedValue([]);
  });

  it("statusFilter ALL sem visibilidade: só a organização e as etapas do funil", async () => {
    oneStageBoard(1);
    const out = await withOrg(ORG, () => getBoardData("pipe-1", null, "ALL"));
    const { text, values } = rankedCall();
    expect(text).toContain('WHERE d."organizationId" = ? AND d."stageId" = ANY(?) AND (TRUE)');
    expect(values).toEqual([ORG, ["stage-a"], expect.any(Number)]);
    expect(h.prisma.deal.groupBy).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ totalCount: 1, hasMore: false });
    h.prisma.$queryRaw.mockReset().mockResolvedValue([]);
  });

  it("cards de TODAS as etapas saem de UMA consulta ranqueada com o MESMO where de visibilidade", async () => {
    h.prisma.stage.findMany.mockResolvedValueOnce([
      { id: "stage-a", pipelineId: "pipe-1", position: 0, isWon: false, isLost: false, rottingDays: 7 },
      { id: "stage-b", pipelineId: "pipe-1", position: 1, isWon: false, isLost: false, rottingDays: 7 },
    ]);
    // A janela devolve só (id, stageId, rn); as outras `$queryRaw` do board
    // (produtos / conversas / mensagens) seguem vazias.
    h.prisma.$queryRaw.mockImplementation(async (first: unknown) =>
      isRankedWindowSql(first)
        ? [
            { id: "deal-a1", stageId: "stage-a", rn: 1 },
            { id: "deal-b1", stageId: "stage-b", rn: 1 },
          ]
        : [],
    );
    const updatedAt = new Date();
    h.prisma.deal.findMany.mockResolvedValueOnce([
      { id: "deal-b1", stageId: "stage-b", contactId: null, contact: null, updatedAt, tags: [], activities: [] },
      { id: "deal-a1", stageId: "stage-a", contactId: null, contact: null, updatedAt, tags: [], activities: [] },
    ]);

    const out = await withOrg(ORG, () => getBoardData("pipe-1", { ownerId: "u1" }));

    // 1) UMA janela para todas as etapas: o where de visibilidade (status
    //    OPEN + ownerId) entra uma única vez, fora da partição por etapa —
    //    é o mesmo predicado para cada coluna. Valores só como parâmetros.
    const ranked = h.prisma.$queryRaw.mock.calls.map((c) => c[0]).filter(isRankedWindowSql);
    expect(ranked).toHaveLength(1);
    const text = ranked[0]!.strings.join("?").replace(/\s+/g, " ");
    expect(text).toContain('ROW_NUMBER() OVER ( PARTITION BY d."stageId" ORDER BY');
    expect(text).toContain(
      'WHERE d."organizationId" = ? AND d."stageId" = ANY(?) AND ((d."status" = ?::"DealStatus" AND d."ownerId" = ?))',
    );
    expect(ranked[0]!.values).toEqual([ORG, ["stage-a", "stage-b"], "OPEN", "u1", expect.any(Number)]);

    // 2) Nenhum `findMany` por etapa: só a hidratação por `id IN` dos ids
    //    que a janela devolveu.
    expect(h.prisma.deal.findMany).toHaveBeenCalledTimes(1);
    const hydrate = h.prisma.deal.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(hydrate.where).toEqual({ id: { in: ["deal-a1", "deal-b1"] } });

    // 3) Cada card volta na própria etapa.
    expect(out.map((s) => [s.id, s.deals.map((d) => d.id)])).toEqual([
      ["stage-a", ["deal-a1"]],
      ["stage-b", ["deal-b1"]],
    ]);

    h.prisma.$queryRaw.mockReset().mockResolvedValue([]);
  });

  it("fora de contexto de org não consulta nada", async () => {
    await expect(getBoardData("pipe-1")).rejects.toThrow(/organization context ausente/);
    expect(h.cacheWrap).not.toHaveBeenCalled();
    expect(h.prisma.deal.groupBy).not.toHaveBeenCalled();
  });
});

const MOVED_AT = new Date("2026-10-06T12:00:01.000Z");

function activeMovedDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    title: "Lead",
    value: 10,
    status: "OPEN",
    lostReason: null,
    position: 3,
    expectedClose: null,
    createdAt: new Date("2026-10-06T12:00:00.000Z"),
    updatedAt: MOVED_AT,
    stageId: "stage-b",
    contact: { id: "c1", name: "Ana", email: null, phone: null, avatarUrl: null },
    owner: null,
    tags: [],
    stage: { id: "stage-b", pipelineId: "pipe-1", isWon: false, isLost: false },
    ...overrides,
  };
}

describe("syncBoardsAfterDealChanges — board depois de gravações fora do moveDeal", () => {
  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  const rowsOf = (...deals: Array<ReturnType<typeof activeMovedDeal>>) =>
    new Map(deals.map((d) => [d.id, d]));

  function sync(args: Parameters<typeof syncBoardsAfterDealChanges>[0], orgId: string | null = ORG) {
    if (!orgId) return syncBoardsAfterDealChanges(args);
    return withOrg(orgId, () => syncBoardsAfterDealChanges(args));
  }

  function dealMovedEvents() {
    return h.ssePublish.mock.calls.filter((c) => c[0] === "deal_moved").map((c) => c[1]);
  }

  it("Qualificado → Novo: publica deal_moved com a linha já gravada, sem nova leitura", async () => {
    const deal = activeMovedDeal({
      id: "deal-caio",
      title: "Caio",
      stageId: "stage-novo",
      position: 4,
      stage: { pipelineId: "pipe-1", isWon: false, isLost: false },
    });

    const out = await sync({
      changes: [{ dealId: "deal-caio", fromStageId: "stage-qualificado", fromPipelineId: "pipe-1" }],
      rows: rowsOf(deal),
    });
    await flush();

    expect(out.published).toBe(1);
    expect(h.prisma.deal.findMany).not.toHaveBeenCalled();
    expect(h.ssePublish).toHaveBeenCalledTimes(1);
    expect(h.ssePublish.mock.calls[0]![0]).toBe("deal_moved");
    expect(h.ssePublish.mock.calls[0]![1]).toMatchObject({
      dealId: "deal-caio",
      organizationId: ORG,
      fromPipelineId: "pipe-1",
      toPipelineId: "pipe-1",
      fromStageId: "stage-qualificado",
      toStageId: "stage-novo",
      position: 4,
      updatedAt: MOVED_AT.toISOString(),
      card: { id: "deal-caio", title: "Caio", status: "OPEN", position: 4 },
    });
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    // Cache primeiro, evento depois.
    expect(h.invalidateBoardData.mock.invocationCallOrder[0]!).toBeLessThan(
      h.ssePublish.mock.invocationCallOrder[0]!,
    );
  });

  it("Ganho e Perdido também invalidam o board e publicam o card com o status novo", async () => {
    await sync({
      changes: [{ dealId: "deal-1", fromStageId: "stage-a", fromPipelineId: "pipe-1" }],
      rows: rowsOf(
        activeMovedDeal({
          status: "WON",
          stageId: "stage-won",
          stage: { pipelineId: "pipe-1", isWon: true, isLost: false },
        }),
      ),
    });
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    expect(dealMovedEvents()).toHaveLength(1);
    expect(dealMovedEvents()[0]).toMatchObject({ toStageId: "stage-won", card: { status: "WON" } });

    h.ssePublish.mockClear();
    h.invalidateBoardData.mockClear();
    await sync({
      changes: [{ dealId: "deal-1", fromStageId: "stage-a", fromPipelineId: "pipe-1" }],
      rows: rowsOf(
        activeMovedDeal({
          status: "LOST",
          stageId: "stage-lost",
          stage: { pipelineId: "pipe-1", isWon: false, isLost: true },
        }),
      ),
    });
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    expect(dealMovedEvents()[0]).toMatchObject({ toStageId: "stage-lost", card: { status: "LOST" } });
  });

  it("troca de funil: invalida origem e destino, uma vez cada", async () => {
    await sync({
      changes: [
        { dealId: "d1", fromStageId: "stage-x", fromPipelineId: "pipe-2" },
        { dealId: "d2", fromStageId: "stage-x", fromPipelineId: "pipe-2" },
      ],
      rows: rowsOf(activeMovedDeal({ id: "d1" }), activeMovedDeal({ id: "d2" })),
    });

    expect(h.invalidateBoardData).toHaveBeenCalledTimes(2);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-2");
    expect(dealMovedEvents()[0]).toMatchObject({ fromPipelineId: "pipe-2", toPipelineId: "pipe-1" });
  });

  it("sem origem informada (só troca de dono) o evento sai com from = to", async () => {
    await sync({
      changes: [{ dealId: "deal-1" }],
      rows: rowsOf(activeMovedDeal({ ownerId: "user-9", orgUnitId: "unit-3" })),
    });

    expect(dealMovedEvents()[0]).toMatchObject({
      fromStageId: "stage-b",
      toStageId: "stage-b",
      fromPipelineId: "pipe-1",
      toPipelineId: "pipe-1",
      ownerId: "user-9",
      orgUnitId: "unit-3",
    });
  });

  it("linhas que faltam saem numa única leitura para o lote", async () => {
    h.prisma.deal.findMany.mockResolvedValueOnce([
      activeMovedDeal({ id: "d1" }),
      activeMovedDeal({ id: "d2" }),
    ]);

    const out = await sync({ changes: [{ dealId: "d1" }, { dealId: "d2" }] });

    expect(h.prisma.deal.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.deal.findMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: ["d1", "d2"] } },
    });
    expect(out.published).toBe(2);
  });

  it("até o teto publica um evento por negócio; acima só invalida o board", async () => {
    const small = Array.from({ length: DEAL_MOVED_BATCH_LIMIT }, (_, i) =>
      activeMovedDeal({ id: `s${i}` }),
    );
    const outSmall = await sync({
      changes: small.map((d) => ({ dealId: d.id })),
      rows: rowsOf(...small),
    });
    expect(outSmall.published).toBe(DEAL_MOVED_BATCH_LIMIT);
    expect(dealMovedEvents()).toHaveLength(DEAL_MOVED_BATCH_LIMIT);
    // Um único purge do funil, não um por negócio.
    expect(h.invalidateBoardData).toHaveBeenCalledTimes(1);

    h.ssePublish.mockClear();
    h.invalidateBoardData.mockClear();
    h.prisma.deal.findMany.mockClear();
    const many = Array.from({ length: DEAL_MOVED_BATCH_LIMIT + 1 }, (_, i) => ({ dealId: `m${i}` }));
    const outMany = await sync({ changes: many, extraPipelineIds: ["pipe-1", "pipe-2"] });
    expect(outMany.published).toBe(0);
    expect(dealMovedEvents()).toHaveLength(0);
    expect(h.prisma.deal.findMany).not.toHaveBeenCalled();
    expect(h.invalidateBoardData).toHaveBeenCalledTimes(2);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-1");
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-2");
  });

  it("falha do Redis na invalidação não impede o evento nem lança", async () => {
    h.invalidateBoardData.mockRejectedValueOnce(new Error("redis fora"));

    const out = await sync({
      changes: [{ dealId: "deal-1" }],
      rows: rowsOf(activeMovedDeal()),
    });

    expect(out.published).toBe(1);
  });

  it("falha na leitura das linhas ainda invalida os funis conhecidos", async () => {
    h.prisma.deal.findMany.mockRejectedValueOnce(new Error("banco fora"));

    const out = await sync({
      changes: [{ dealId: "d1", fromStageId: "stage-a", fromPipelineId: "pipe-2" }],
    });

    expect(out.published).toBe(0);
    expect(h.invalidateBoardData).toHaveBeenCalledWith(ORG, "pipe-2");
  });

  it("não faz nada sem organizationId", async () => {
    const out = await sync(
      { changes: [{ dealId: "deal-1" }], rows: rowsOf(activeMovedDeal()) },
      null,
    );
    await flush();

    expect(out.published).toBe(0);
    expect(h.ssePublish).not.toHaveBeenCalled();
    expect(h.invalidateBoardData).not.toHaveBeenCalled();
  });

  it("orgId explícito funciona fora do contexto (job)", async () => {
    const out = await sync(
      { orgId: "org-job", changes: [{ dealId: "deal-1" }], rows: rowsOf(activeMovedDeal()) },
      null,
    );

    expect(out.published).toBe(1);
    expect(h.invalidateBoardData).toHaveBeenCalledWith("org-job", "pipe-1");
    expect(dealMovedEvents()[0]).toMatchObject({ organizationId: "org-job" });
  });
});
