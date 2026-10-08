/**
 * Status/closedAt coerentes com a etapa terminal em TODOS os caminhos que
 * gravam `stageId`, não só no move do Kanban: criação direta na coluna
 * Perdido/Ganho (importação, API, automação, IA) e `updateDeal` com `stageId`.
 *
 * Fecha a divergência Kanban × painel: o Kanban conta por etapa, o painel por
 * `status` + `closedAt` no período. Um card criado direto em "Perdido" ficava
 * OPEN/closedAt nulo e sumia dos perdidos do painel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const fns = {
    dealFindUnique: vi.fn(),
    dealFindFirst: vi.fn(),
    dealFindMany: vi.fn(),
    dealCreate: vi.fn(),
    dealUpdate: vi.fn(),
    dealUpdateMany: vi.fn(),
    dealAggregate: vi.fn(),
    stageFindUnique: vi.fn(),
    pipelineFindUnique: vi.fn(),
    allocateOrgNumber: vi.fn(async () => 42),
    invalidateBoardData: vi.fn(async () => undefined),
  };
  // Mesmo objeto dentro e fora da transação: o que vale é a chamada.
  const prismaMock = {
    $executeRaw: vi.fn(),
    deal: {
      findUnique: fns.dealFindUnique,
      findFirst: fns.dealFindFirst,
      findMany: fns.dealFindMany,
      create: fns.dealCreate,
      update: fns.dealUpdate,
      updateMany: fns.dealUpdateMany,
      aggregate: fns.dealAggregate,
    },
    stage: { findUnique: fns.stageFindUnique },
    pipeline: { findUnique: fns.pipelineFindUnique },
    contact: { update: vi.fn(), findFirst: vi.fn() },
    conversation: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  return {
    ...fns,
    prismaMock,
    /** Linhas "no banco" para o painel somar (o que `createDeal` gravou). */
    painelRows: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ...h.prismaMock,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(h.prismaMock),
  },
  allocateOrgNumber: h.allocateOrgNumber,
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/cache/keys", () => ({
  boardDataKey: () => "board",
  invalidateBoardData: h.invalidateBoardData,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn(),
  userIdForFk: vi.fn(),
  withAutomationOriginMeta: vi.fn((m: unknown) => m),
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: vi.fn(async () => true),
  getOrgSettingFor: vi.fn(async () => null),
  getOrgSetting: vi.fn(async () => null),
}));
vi.mock("@/services/analytics", () => ({ getStageMetrics: vi.fn(async () => []) }));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async () => undefined),
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/services/kanban-filters", () => ({
  buildDealSearchOr: vi.fn(async () => []),
  buildDealWhereFromFilters: vi.fn(async () => []),
}));

// ── Painel: `aggregate` de verdade sobre `h.painelRows`, só com o que o KPI
// usa (`status` igual e `closedAt` dentro de gte/lte). Sem isso o teste só
// provaria que o mock devolve o que a gente mandou.
type Where = { AND?: Where[]; status?: string; closedAt?: { gte?: Date; lte?: Date } };
const painelAggregate = vi.hoisted(() => {
  function matches(row: Record<string, unknown>, where: Where): boolean {
    if (where.AND && !where.AND.every((w) => matches(row, w))) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.closedAt) {
      const at = row.closedAt instanceof Date ? row.closedAt.getTime() : null;
      if (at == null) return false;
      if (where.closedAt.gte && at < where.closedAt.gte.getTime()) return false;
      if (where.closedAt.lte && at > where.closedAt.lte.getTime()) return false;
    }
    return true;
  }
  return vi.fn(async ({ where }: { where: Where }) => {
    const hit = h.painelRows.filter((r) => matches(r, where));
    return {
      _count: hit.length,
      _sum: { value: hit.reduce((s, r) => s + Number(r.value ?? 0), 0) },
    };
  });
});
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({ deal: { aggregate: painelAggregate } }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/services/dashboard", () => ({ SOURCE_NONE: "__none__" }));
vi.mock("@/services/painel-snapshots", () => ({
  ensureTodayDealStageSnapshot: vi.fn(async () => undefined),
}));

import { runWithContext } from "@/lib/request-context";
import {
  buildNewDealStatusPatch,
  buildStatusSyncPatch,
  createDeal,
  updateDeal,
} from "@/services/deals";
import { getPainelDealsKpis } from "@/services/painel-deals";

const ORG = "org-terminal";
const LOST_STAGE = { isWon: false, isLost: true };
const WON_STAGE = { isWon: true, isLost: false };
const PLAIN_STAGE = { isWon: false, isLost: false };

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext({ organizationId: ORG } as Parameters<typeof runWithContext>[0], fn) as Promise<T>;
}

function createdData(call = 0): Record<string, unknown> {
  return h.dealCreate.mock.calls[call]![0].data as Record<string, unknown>;
}

function updatedData(call = 0): Record<string, unknown> {
  return h.dealUpdate.mock.calls[call]![0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.painelRows = [];
  h.dealAggregate.mockResolvedValue({ _max: { position: 0 } });
  h.dealCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "deal-new",
    ...data,
    stage: { pipelineId: "pipe-a" },
  }));
  h.dealUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "deal-1",
    contactId: null,
    ...data,
    stage: { pipelineId: "pipe-a" },
  }));
});

describe("buildStatusSyncPatch (regra do move)", () => {
  it("etapa Perdido fecha como LOST com closedAt e motivo", () => {
    expect(buildStatusSyncPatch("OPEN", LOST_STAGE, " Preço ")).toEqual({
      status: "LOST",
      closedAt: expect.any(Date),
      lostReason: "Preço",
    });
    expect(buildStatusSyncPatch("WON", LOST_STAGE)).toMatchObject({ status: "LOST", lostReason: null });
  });

  it("já perdido: só troca o motivo quando vem um novo", () => {
    expect(buildStatusSyncPatch("LOST", LOST_STAGE)).toEqual({});
    expect(buildStatusSyncPatch("LOST", LOST_STAGE, "Outro")).toEqual({ lostReason: "Outro" });
  });

  it("etapa Ganho fecha como WON e limpa o motivo", () => {
    expect(buildStatusSyncPatch("OPEN", WON_STAGE)).toEqual({
      status: "WON",
      closedAt: expect.any(Date),
      lostReason: null,
    });
    expect(buildStatusSyncPatch("WON", WON_STAGE)).toEqual({});
  });

  it("etapa comum reabre quem estava fechado e não mexe em quem está aberto", () => {
    expect(buildStatusSyncPatch("LOST", PLAIN_STAGE)).toEqual({
      status: "OPEN",
      closedAt: null,
      lostReason: null,
    });
    expect(buildStatusSyncPatch("OPEN", PLAIN_STAGE)).toEqual({});
  });
});

describe("buildNewDealStatusPatch (nascimento do card)", () => {
  it("etapa terminal manda sobre o status pedido", () => {
    expect(buildNewDealStatusPatch(LOST_STAGE, { status: "OPEN", lostReason: "Sem verba" })).toEqual({
      status: "LOST",
      closedAt: expect.any(Date),
      lostReason: "Sem verba",
    });
    expect(buildNewDealStatusPatch(WON_STAGE, { status: "LOST", lostReason: "x" })).toEqual({
      status: "WON",
      closedAt: expect.any(Date),
      lostReason: null,
    });
  });

  it("etapa comum (ou desconhecida) mantém o que o caller pediu", () => {
    expect(buildNewDealStatusPatch(PLAIN_STAGE, { status: "OPEN" })).toEqual({
      status: "OPEN",
      lostReason: undefined,
    });
    expect(buildNewDealStatusPatch(null, { lostReason: null })).toEqual({
      status: undefined,
      lostReason: null,
    });
  });
});

describe("createDeal direto em etapa terminal", () => {
  it("Perdido: nasce LOST com closedAt (importação/API/automação/IA)", async () => {
    h.stageFindUnique.mockResolvedValue({ pipelineId: "pipe-a", ...LOST_STAGE });

    await withOrg(() => createDeal({ title: "TESTE MIGRACAO", stageId: "stage-lost", status: "OPEN" }));

    expect(createdData()).toMatchObject({
      stageId: "stage-lost",
      status: "LOST",
      closedAt: expect.any(Date),
      lostReason: null,
    });
  });

  it("Ganho: nasce WON, também pelo caminho com contato (transação)", async () => {
    h.stageFindUnique.mockResolvedValue({ pipelineId: "pipe-a", ...WON_STAGE });
    h.pipelineFindUnique.mockResolvedValue({ allowDuplicateDeals: true });

    await withOrg(() => createDeal({ title: "Fechado", contactId: "c1", stageId: "stage-won" }));

    expect(createdData()).toMatchObject({ status: "WON", closedAt: expect.any(Date), lostReason: null });
  });

  it("etapa comum: status pedido e sem closedAt, como antes", async () => {
    h.stageFindUnique.mockResolvedValue({ pipelineId: "pipe-a", ...PLAIN_STAGE });

    await withOrg(() => createDeal({ title: "Novo", stageId: "stage-a", status: "OPEN" }));

    expect(createdData()).toMatchObject({ status: "OPEN" });
    expect(createdData().closedAt).toBeUndefined();
  });
});

describe("updateDeal com stageId (fora do moveDeal)", () => {
  it("para Perdido grava LOST + closedAt junto com a etapa", async () => {
    h.dealFindUnique.mockResolvedValue({ stageId: "stage-a", status: "OPEN", stage: { pipelineId: "pipe-a" } });
    h.stageFindUnique.mockResolvedValue(LOST_STAGE);

    await withOrg(() => updateDeal("deal-1", { stageId: "stage-lost", lostReason: "Desistiu" }));

    expect(updatedData()).toEqual({
      stageId: "stage-lost",
      status: "LOST",
      closedAt: expect.any(Date),
      lostReason: "Desistiu",
    });
  });

  it("etapa terminal manda mesmo com status explícito no payload", async () => {
    h.dealFindUnique.mockResolvedValue({ stageId: "stage-a", status: "OPEN", stage: { pipelineId: "pipe-a" } });
    h.stageFindUnique.mockResolvedValue(WON_STAGE);

    await withOrg(() => updateDeal("deal-1", { stageId: "stage-won", status: "OPEN" }));

    expect(updatedData()).toMatchObject({ stageId: "stage-won", status: "WON", closedAt: expect.any(Date) });
  });

  it("de Perdido para etapa comum reabre (mesma regra do move)", async () => {
    h.dealFindUnique.mockResolvedValue({ stageId: "stage-lost", status: "LOST", stage: { pipelineId: "pipe-a" } });
    h.stageFindUnique.mockResolvedValue(PLAIN_STAGE);

    await withOrg(() => updateDeal("deal-1", { stageId: "stage-b" }));

    expect(updatedData()).toEqual({ stageId: "stage-b", status: "OPEN", closedAt: null, lostReason: null });
  });

  it("etapa comum com status explícito no payload mantém o status pedido", async () => {
    h.dealFindUnique.mockResolvedValue({ stageId: "stage-lost", status: "LOST", stage: { pipelineId: "pipe-a" } });
    h.stageFindUnique.mockResolvedValue(PLAIN_STAGE);

    await withOrg(() => updateDeal("deal-1", { stageId: "stage-b", status: "LOST" }));

    expect(updatedData()).toEqual({ stageId: "stage-b", status: "LOST" });
  });

  it("mesma etapa não mexe no status", async () => {
    h.dealFindUnique.mockResolvedValue({ stageId: "stage-lost", status: "OPEN", stage: { pipelineId: "pipe-a" } });
    h.stageFindUnique.mockResolvedValue(LOST_STAGE);

    await withOrg(() => updateDeal("deal-1", { stageId: "stage-lost", title: "Renomeado" }));

    expect(updatedData()).toEqual({ stageId: "stage-lost", title: "Renomeado" });
  });

  it("sem stageId não consulta etapa nem status", async () => {
    await withOrg(() => updateDeal("deal-1", { title: "Só título" }));

    expect(h.stageFindUnique).not.toHaveBeenCalled();
    expect(updatedData()).toEqual({ title: "Só título" });
  });
});

