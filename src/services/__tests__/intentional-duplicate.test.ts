/**
 * Duplicar intencional: nascimento do card, unificação que ignora o flag
 * e dono copiado para os OPEN do contato.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    dealFindUnique: vi.fn(),
    dealFindFirst: vi.fn(),
    dealFindMany: vi.fn(),
    dealCreate: vi.fn(),
    dealUpdate: vi.fn(),
    dealUpdateMany: vi.fn(),
    dealAggregate: vi.fn(),
    stageFindUnique: vi.fn(),
    pipelineFindUnique: vi.fn(),
    contactUpdate: vi.fn(),
    conversationFindMany: vi.fn(),
    allocateOrgNumber: vi.fn(async () => 77),
    invalidateBoardData: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $executeRaw: vi.fn(),
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRaw: vi.fn(),
        deal: {
          findUnique: h.dealFindUnique,
          findFirst: h.dealFindFirst,
          findMany: h.dealFindMany,
          create: h.dealCreate,
          update: h.dealUpdate,
          updateMany: h.dealUpdateMany,
          aggregate: h.dealAggregate,
        },
        stage: { findUnique: h.stageFindUnique },
        pipeline: { findUnique: h.pipelineFindUnique },
        contact: { update: h.contactUpdate, findFirst: vi.fn() },
        conversation: { findMany: h.conversationFindMany, updateMany: vi.fn() },
        user: { findUnique: vi.fn() },
      }),
    deal: {
      findUnique: h.dealFindUnique,
      findFirst: h.dealFindFirst,
      findMany: h.dealFindMany,
      create: h.dealCreate,
      update: h.dealUpdate,
      updateMany: h.dealUpdateMany,
      aggregate: h.dealAggregate,
    },
    stage: { findUnique: h.stageFindUnique },
    pipeline: { findUnique: h.pipelineFindUnique },
    contact: { update: h.contactUpdate },
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

import { runWithContext } from "@/lib/request-context";
import { classifyMessageDeals } from "@/services/automation-triggers";
import {
  intentionalStageClusterIds,
  shouldSkipIntentionalStageRetrigger,
} from "@/services/intentional-stage-cluster";
import {
  assignDealOwner,
  createDeal,
  duplicateDeal,
  duplicateTargetError,
  wasReusedOpenDeal,
} from "@/services/deals";

const ORG = "org-dup";

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext({ organizationId: ORG } as Parameters<typeof runWithContext>[0], fn) as Promise<T>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dealAggregate.mockResolvedValue({ _max: { position: 0 } });
  h.conversationFindMany.mockResolvedValue([]);
  h.contactUpdate.mockResolvedValue({});
  h.dealCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "new-deal",
    ...data,
    stage: { pipelineId: "pipe-b" },
  }));
});

describe("classifyMessageDeals", () => {
  it("sem filtro e com vários OPEN não escolhe card", () => {
    expect(classifyMessageDeals({ filterActive: false, matchedIds: [], openIds: ["a", "b"] })).toEqual({
      mode: "ambiguous",
    });
  });

  it("sem filtro e com um OPEN usa esse card", () => {
    expect(classifyMessageDeals({ filterActive: false, matchedIds: [], openIds: ["a"] })).toEqual({
      mode: "single-open",
      dealId: "a",
    });
  });

  it("com filtro usa só o conjunto casado, na ordem recebida", () => {
    expect(classifyMessageDeals({ filterActive: true, matchedIds: ["old", "new"], openIds: [] })).toEqual({
      mode: "matched",
      dealId: "old",
      matchedIds: ["old", "new"],
    });
  });

  it("filtro sem card é erro fechado", () => {
    expect(classifyMessageDeals({ filterActive: true, matchedIds: [], openIds: ["a"] })).toEqual({
      mode: "filter-miss",
    });
  });
});

describe("conjunto de duplicata de propósito na etapa", () => {
  const rows = [
    {
      id: "origin",
      intentionalDuplicate: false,
      duplicatedFromDealId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "copy",
      intentionalDuplicate: true,
      duplicatedFromDealId: "origin",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    },
    {
      id: "other",
      intentionalDuplicate: false,
      duplicatedFromDealId: null,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  ];

  it("inclui origem e cópia, na ordem de criação, e deixa o card sem vínculo", () => {
    expect(intentionalStageClusterIds(rows)).toEqual(["origin", "copy"]);
  });

  it("com fluxo já existente, quem chega não recomeça", () => {
    expect(
      shouldSkipIntentionalStageRetrigger({
        dealId: "copy",
        clusterIdsOldestFirst: ["origin", "copy"],
        hasPriorContext: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipIntentionalStageRetrigger({
        dealId: "copy",
        clusterIdsOldestFirst: ["origin", "copy"],
        hasPriorContext: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipIntentionalStageRetrigger({
        dealId: "only",
        clusterIdsOldestFirst: ["only"],
        hasPriorContext: true,
      }),
    ).toBe(false);
  });
});

describe("duplicateTargetError", () => {
  it("recusa etapa terminal e etapa de outro funil", () => {
    expect(duplicateTargetError(null, "p")).toBe("STAGE_NOT_FOUND");
    expect(duplicateTargetError({ pipelineId: "other", isWon: false, isLost: false }, "p")).toBe(
      "STAGE_PIPELINE_MISMATCH",
    );
    expect(duplicateTargetError({ pipelineId: "p", isWon: true, isLost: false }, "p")).toBe("TERMINAL_STAGE");
    expect(duplicateTargetError({ pipelineId: "p", isWon: false, isLost: false }, "p")).toBeNull();
  });
});

describe("duplicateDeal", () => {
  it("nasce OPEN, vazio de valor, com o mesmo contato, título e dono", async () => {
    h.dealFindUnique.mockResolvedValue({
      id: "src",
      title: "Administração",
      contactId: "contact-1",
      ownerId: "owner-1",
      dealRole: "COMMERCIAL",
    });
    h.stageFindUnique.mockResolvedValue({
      id: "stage-b",
      pipelineId: "pipe-b",
      isWon: false,
      isLost: false,
    });
    h.pipelineFindUnique.mockResolvedValue({ id: "pipe-b", archivedAt: null });

    const created = await withOrg(() => duplicateDeal("src", { pipelineId: "pipe-b", stageId: "stage-b" }));
    const data = h.dealCreate.mock.calls[0]![0].data as Record<string, unknown>;

    expect(data).toMatchObject({
      title: "Administração",
      contactId: "contact-1",
      ownerId: "owner-1",
      stageId: "stage-b",
      status: "OPEN",
      value: 0,
      dealRole: "COMMERCIAL",
      intentionalDuplicate: true,
      duplicatedFromDealId: "src",
      number: 77,
    });
    expect(data.externalId).toBeUndefined();
    expect(created.id).toBe("new-deal");
    expect(h.invalidateBoardData).toHaveBeenCalled();
  });

  it("não cria em etapa Ganho", async () => {
    h.dealFindUnique.mockResolvedValue({
      id: "src",
      title: "A",
      contactId: "c",
      ownerId: null,
      dealRole: "COMMERCIAL",
    });
    h.stageFindUnique.mockResolvedValue({
      id: "won",
      pipelineId: "pipe-b",
      isWon: true,
      isLost: false,
    });
    h.pipelineFindUnique.mockResolvedValue({ id: "pipe-b", archivedAt: null });
    await expect(withOrg(() => duplicateDeal("src", { pipelineId: "pipe-b", stageId: "won" }))).rejects.toThrow(
      "TERMINAL_STAGE",
    );
    expect(h.dealCreate).not.toHaveBeenCalled();
  });
});

describe("dedupe acidental", () => {
  it("a unificação SQL ignora intentionalDuplicate", () => {
    const sql = readFileSync(resolve(__dirname, "../deal-duplicates.ts"), "utf8");
    const hits = sql.split('d."intentionalDuplicate" = false').length - 1;
    expect(hits).toBe(2);
  });

  it("com duplicata proibida, o card intencional não é reaproveitado", async () => {
    h.stageFindUnique.mockResolvedValue({ pipelineId: "pipe-a" });
    h.pipelineFindUnique.mockResolvedValue({ allowDuplicateDeals: false });
    h.dealFindFirst.mockResolvedValue(null);

    const created = await withOrg(() =>
      createDeal({
        title: "Novo",
        contactId: "contact-1",
        stageId: "stage-a",
        status: "OPEN",
        dealRole: "COMMERCIAL",
      }),
    );

    expect(wasReusedOpenDeal(created)).toBe(false);
    expect(h.dealFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ intentionalDuplicate: false, status: "OPEN" }),
      }),
    );
    expect(h.dealCreate).toHaveBeenCalled();
  });
});

describe("assignDealOwner", () => {
  it("grava o mesmo dono nos outros negócios OPEN do contato", async () => {
    h.dealFindUnique.mockResolvedValue({ ownerId: "old", contactId: "contact-1" });
    h.dealUpdate.mockResolvedValue({
      id: "deal-a",
      contactId: "contact-1",
      ownerId: "owner-2",
      stage: { pipelineId: "pipe-a" },
    });
    h.dealFindMany.mockResolvedValue([
      { id: "deal-b", stage: { pipelineId: "pipe-b" } },
    ]);

    await withOrg(() => assignDealOwner("deal-a", "owner-2"));

    expect(h.dealUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["deal-b"] } },
      data: { ownerId: "owner-2" },
    });
  });
});
