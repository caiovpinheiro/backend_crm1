import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentFindMany: vi.fn(),
  versionGroupBy: vi.fn(),
  turnGroupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findMany: mocks.agentFindMany },
    aIAgentConfigVersion: { groupBy: mocks.versionGroupBy },
    aISimpleTurnLog: { groupBy: mocks.turnGroupBy },
  },
}));

import { listV2Agents } from "../agents";

const cfg = (extra: Record<string, unknown> = {}) => ({ name: "A", tone: "t", ...extra });

describe("listV2Agents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("traz versão, alterações, canais, fase de teste e números de hoje", async () => {
    mocks.agentFindMany.mockResolvedValue([
      {
        id: "a1", active: true, createdAt: new Date(), updatedAt: new Date(), user: { name: "Agente 1" },
        simpleConfig: cfg({ channelIds: ["c1"] }),
        draftConfig: cfg({ channelIds: ["c1", "c2"], allowedPhoneNumbers: ["11999999999"], autonomyMode: "auto" }),
      },
      { id: "a2", active: false, createdAt: new Date(), updatedAt: new Date(), user: { name: "Agente 2" }, simpleConfig: cfg(), draftConfig: null },
    ]);
    mocks.versionGroupBy.mockResolvedValue([{ agentId: "a1", _max: { versionNumber: 7 } }]);
    mocks.turnGroupBy.mockImplementation(async (args: { by: string[] }) =>
      args.by.length === 2
        ? [{ agentId: "a1", conversationId: "x" }, { agentId: "a1", conversationId: "y" }]
        : [{ agentId: "a1", _count: { _all: 1 } }],
    );

    const [a1, a2] = await listV2Agents("org");
    expect(a1).toMatchObject({
      lastVersionNumber: 7, hasUnpublishedChanges: true, channelCount: 2, testPhoneCount: 1,
      autonomyMode: "auto", conversationsToday: 2, handoffsToday: 1,
    });
    expect(a2).toMatchObject({ lastVersionNumber: 0, hasUnpublishedChanges: false, conversationsToday: 0 });
  });

  it("traz o modelo e o gasto de hoje pelo preço do modelo (sem preço: teto do provedor)", async () => {
    mocks.agentFindMany.mockResolvedValue([
      { id: "a1", active: true, createdAt: new Date(), updatedAt: new Date(), user: { name: "A" }, simpleConfig: cfg({ model: "gpt-4o-mini" }), draftConfig: null },
      { id: "a2", active: true, createdAt: new Date(), updatedAt: new Date(), user: { name: "B" }, simpleConfig: cfg({ model: "gpt-6.1-terra" }), draftConfig: null },
    ]);
    mocks.versionGroupBy.mockResolvedValue([]);
    mocks.turnGroupBy.mockImplementation(async (args: { by: string[]; _sum?: unknown }) =>
      args._sum
        ? [
            { agentId: "a1", _sum: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
            { agentId: "a2", _sum: { inputTokens: 1_000_000, outputTokens: 0 } },
          ]
        : [],
    );
    const [a1, a2] = await listV2Agents("org");
    expect(a1).toMatchObject({ model: "gpt-4o-mini", costPriceSource: "builtin", inputTokensToday: 1_000_000 });
    expect(a1.costTodayUsd).toBeCloseTo(0.75, 4);
    expect(a2).toMatchObject({ model: "gpt-6.1-terra", costPriceSource: "unknown" });
    expect(a2.costTodayUsd).toBeCloseTo(4, 4);
  });

  it("sem registro de turnos, a lista continua funcionando", async () => {
    mocks.agentFindMany.mockResolvedValue([
      { id: "a1", active: true, createdAt: new Date(), updatedAt: new Date(), user: { name: "A" }, simpleConfig: cfg(), draftConfig: null },
    ]);
    mocks.versionGroupBy.mockResolvedValue([]);
    mocks.turnGroupBy.mockRejectedValue(new Error("relation does not exist"));
    const [a1] = await listV2Agents("org");
    expect(a1.conversationsToday).toBe(0);
  });
});
