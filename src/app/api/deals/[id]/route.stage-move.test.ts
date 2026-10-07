/**
 * Mover negócio de etapa — `POST /api/deals/:id/move` e `PUT /api/deals/:id`
 * com `stageId` passam pelo mesmo caminho (`moveDealForUser`).
 *
 * Antes:
 *  - o /move não conferia de quem era o negócio (qualquer usuário com
 *    `deal:change_stage` movia o card de outro dono, que o GET devolve 403);
 *  - o PUT com `stageId` usava `updateDeal` direto: pulava os campos
 *    obrigatórios da etapa, o motivo de perda e o `deal_moved`.
 *
 * `moveDeal` e `assertStageEntryFields` são os REAIS (Postgres simulado):
 * o 400 STAGE_FIELDS_REQUIRED sai da regra de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    deal: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    stage: { findUnique: vi.fn() },
    customField: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  return {
    tx,
    prisma,
    visibility: { canSeeAll: false, includeUnassigned: false },
    existing: null as unknown,
    createDealEvent: vi.fn().mockResolvedValue(undefined),
    fireTrigger: vi.fn().mockResolvedValue(undefined),
    updateDeal: vi.fn(),
    moveDeal: vi.fn(),
    realMoveDeal: null as null | ((...args: unknown[]) => Promise<unknown>),
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
  onCandidateStageMove: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/fulfillment", () => ({ onCommercialDealWon: vi.fn() }));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async (c: unknown[]) => c),
}));
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: h.fireTrigger }));
vi.mock("@/services/contacts", () => ({ getDealPanelFieldsForDeal: vi.fn() }));
vi.mock("@/services/deals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/deals")>();
  h.realMoveDeal = actual.moveDeal as unknown as typeof h.realMoveDeal;
  return {
    ...actual,
    getDealById: vi.fn(async () => h.existing),
    updateDeal: h.updateDeal,
    createDealEvent: h.createDealEvent,
    moveDeal: h.moveDeal,
  };
});

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) =>
    cb({ user: { id: "user_a", role: "MEMBER", organizationId: "org_1", isSuperAdmin: false } }),
}));
vi.mock("@/lib/api-auth", async () => {
  const { runWithContext } = await import("@/lib/request-context");
  return {
    authenticateApiRequest: vi.fn(async () => ({
      ok: true,
      user: { id: "user_a", role: "MEMBER", organizationId: "org_1", isSuperAdmin: false },
    })),
    runWithApiUserContext: (user: { id: string; organizationId: string }, fn: () => unknown) =>
      runWithContext(
        { organizationId: user.organizationId, userId: user.id, isSuperAdmin: false } as never,
        fn,
      ),
  };
});
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePermissionForUser: vi.fn(async () => null),
  requireStageScope: vi.fn(async () => null),
  requirePipelineScope: vi.fn(async () => null),
  canEditFieldForUser: vi.fn(async () => true),
}));
vi.mock("@/lib/visibility", async (importOriginal) => ({
  canSeeDealByOwner: (await importOriginal<typeof import("@/lib/visibility")>()).canSeeDealByOwner,
  getVisibilityFilter: vi.fn(async () => ({ ...h.visibility, dealWhere: {} })),
}));

import { POST as move } from "@/app/api/deals/[id]/move/route";
import { PUT as put } from "@/app/api/deals/[id]/route";

function existingDeal(ownerId: string | null) {
  return {
    id: "deal-1",
    title: "Negócio",
    value: 100,
    status: "OPEN",
    contactId: "c1",
    expectedClose: null,
    ownerId,
    owner: ownerId ? { id: ownerId, name: "Dono" } : null,
    stage: {
      id: "stage-a",
      name: "Novo",
      pipeline: { id: "pipe-1", name: "Funil" },
    },
  };
}

const STAGE_B = {
  id: "stage-b",
  name: "Qualificado",
  pipelineId: "pipe-1",
  isWon: false,
  isLost: false,
  requiredDealFieldIds: [] as string[],
};

function postMove(body: Record<string, unknown>) {
  return move(
    new Request("https://api.test/api/deals/deal-1/move", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "deal-1" }) },
  );
}

function putDeal(body: Record<string, unknown>) {
  return put(
    new Request("https://api.test/api/deals/deal-1", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "deal-1" }) },
  );
}

const moveSpy = h.moveDeal;

beforeEach(() => {
  vi.clearAllMocks();
  h.visibility = { canSeeAll: false, includeUnassigned: false };
  h.existing = existingDeal("user_a");
  h.prisma.stage.findUnique.mockImplementation(async () => ({ ...STAGE_B }));
  h.prisma.deal.findUnique.mockResolvedValue({
    id: "deal-1",
    stageId: "stage-a",
    stage: { pipelineId: "pipe-1" },
    customFields: [],
  });
  h.prisma.customField.findMany.mockResolvedValue([
    { id: "cf-1", label: "Curso", name: "curso", type: "TEXT" },
  ]);
  h.updateDeal.mockResolvedValue({ id: "deal-1", title: "Novo título" });
  // Por padrão o move é o REAL (Postgres simulado); nos casos de sucesso o
  // retorno é controlado.
  moveSpy.mockImplementation((...args: unknown[]) => h.realMoveDeal!(...args));
});

describe("POST /api/deals/:id/move — posse do negócio", () => {
  it("usuário 'só meus' movendo negócio de OUTRO dono recebe 403 e nada é gravado", async () => {
    h.existing = existingDeal("user_b");
    moveSpy.mockResolvedValue({ id: "deal-1" });

    const res = await postMove({ stageId: "stage-b", position: 0 });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Acesso negado." });
    expect(moveSpy).not.toHaveBeenCalled();
    expect(h.createDealEvent).not.toHaveBeenCalled();
    expect(h.fireTrigger).not.toHaveBeenCalled();
  });

  it("negócio SEM dono: 403 sem o eixo 'sem responsável'; com o eixo, move", async () => {
    h.existing = existingDeal(null);
    moveSpy.mockResolvedValue({ id: "deal-1", status: "OPEN", stage: { id: "stage-b", name: "Q" } });

    const denied = await postMove({ stageId: "stage-b", position: 0 });
    expect(denied.status).toBe(403);

    h.visibility = { canSeeAll: false, includeUnassigned: true };
    const ok = await postMove({ stageId: "stage-b", position: 0 });
    expect(ok.status).toBe(200);
  });

  it("dono do negócio move (200) e a timeline registra a troca de etapa", async () => {
    moveSpy.mockResolvedValue({
      id: "deal-1",
      status: "OPEN",
      stage: { id: "stage-b", name: "Qualificado", pipeline: { id: "pipe-1", name: "Funil" } },
    });

    const res = await postMove({ stageId: "stage-b", position: 3 });

    expect(res.status).toBe(200);
    expect(moveSpy).toHaveBeenCalledWith("deal-1", "stage-b", 3, { lostReason: undefined });
    expect(h.createDealEvent).toHaveBeenCalledWith(
      "deal-1",
      "user_a",
      "STAGE_CHANGED",
      expect.objectContaining({ from: expect.objectContaining({ id: "stage-a" }) }),
    );
    expect(h.fireTrigger).toHaveBeenCalledWith("stage_changed", expect.anything());
  });

  it("quem vê tudo (canSeeAll) move negócio de outro dono", async () => {
    h.existing = existingDeal("user_b");
    h.visibility = { canSeeAll: true, includeUnassigned: true };
    moveSpy.mockResolvedValue({ id: "deal-1", status: "OPEN", stage: { id: "stage-b", name: "Q" } });

    const res = await postMove({ stageId: "stage-b", position: 0 });

    expect(res.status).toBe(200);
  });

  it("campo obrigatório da etapa vazio continua 400 STAGE_FIELDS_REQUIRED", async () => {
    h.prisma.stage.findUnique.mockImplementation(async () => ({
      ...STAGE_B,
      requiredDealFieldIds: ["cf-1"],
    }));

    const res = await postMove({ stageId: "stage-b", position: 0 });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "STAGE_FIELDS_REQUIRED",
      fields: [{ id: "cf-1", label: "Curso" }],
    });
  });
});

describe("PUT /api/deals/:id com stageId — mesmo caminho do /move", () => {
  it("campo obrigatório da etapa vazio: 400 STAGE_FIELDS_REQUIRED e nada é gravado", async () => {
    h.prisma.stage.findUnique.mockImplementation(async () => ({
      ...STAGE_B,
      requiredDealFieldIds: ["cf-1"],
    }));

    const res = await putDeal({ stageId: "stage-b" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "STAGE_FIELDS_REQUIRED",
      fields: [{ id: "cf-1", label: "Curso" }],
    });
    expect(h.updateDeal).not.toHaveBeenCalled();
    expect(h.tx.deal.update).not.toHaveBeenCalled();
  });

  it("negócio de outro dono ('só meus'): 403 também pelo PUT", async () => {
    h.existing = existingDeal("user_b");

    const res = await putDeal({ stageId: "stage-b" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Acesso negado." });
    expect(h.updateDeal).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it("só stageId: move pelo moveDeal (fim da coluna), sem updateDeal, e registra STAGE_CHANGED uma vez", async () => {
    moveSpy.mockResolvedValue({
      id: "deal-1",
      status: "OPEN",
      stage: { id: "stage-b", name: "Qualificado", pipeline: { id: "pipe-1", name: "Funil" } },
    });

    const res = await putDeal({ stageId: "stage-b" });

    expect(res.status).toBe(200);
    expect(moveSpy).toHaveBeenCalledWith("deal-1", "stage-b", Number.MAX_SAFE_INTEGER, {
      lostReason: undefined,
    });
    expect(h.updateDeal).not.toHaveBeenCalled();
    const stageEvents = h.createDealEvent.mock.calls.filter((c) => c[2] === "STAGE_CHANGED");
    expect(stageEvents).toHaveLength(1);
    const stageTriggers = h.fireTrigger.mock.calls.filter((c) => c[0] === "stage_changed");
    expect(stageTriggers).toHaveLength(1);
  });

  it("stageId + position: usa a position pedida", async () => {
    moveSpy.mockResolvedValue({ id: "deal-1", status: "OPEN", stage: { id: "stage-b", name: "Q" } });

    await putDeal({ stageId: "stage-b", position: 2 });

    expect(moveSpy).toHaveBeenCalledWith("deal-1", "stage-b", 2, { lostReason: undefined });
  });

  it("stageId + título: move e depois atualiza só o resto (sem stageId/position)", async () => {
    moveSpy.mockResolvedValue({ id: "deal-1", status: "OPEN", stage: { id: "stage-b", name: "Q" } });

    const res = await putDeal({ stageId: "stage-b", title: "Novo título" });

    expect(res.status).toBe(200);
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(h.updateDeal).toHaveBeenCalledTimes(1);
    expect(h.updateDeal).toHaveBeenCalledWith("deal-1", { title: "Novo título" });
    expect(moveSpy.mock.invocationCallOrder[0]).toBeLessThan(h.updateDeal.mock.invocationCallOrder[0]);
  });

  it("sem stageId o PUT segue como antes (não passa pelo move)", async () => {
    h.existing = existingDeal("user_b");

    const res = await putDeal({ title: "Novo título" });

    expect(res.status).toBe(200);
    expect(moveSpy).not.toHaveBeenCalled();
    expect(h.updateDeal).toHaveBeenCalledWith("deal-1", { title: "Novo título" });
  });
});
