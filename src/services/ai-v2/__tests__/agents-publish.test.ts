import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentFindFirst: vi.fn(),
  versionFindFirst: vi.fn(),
  versionCreate: vi.fn(),
  agentUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findFirst: mocks.agentFindFirst },
    $transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        aIAgentConfigVersion: { findFirst: mocks.versionFindFirst, create: mocks.versionCreate },
        aIAgentConfig: { update: mocks.agentUpdate },
      }),
  },
}));

import { ActivationNeedsChannelError, publishV2AgentVersion, updateV2Agent } from "../agents";

describe("publishV2AgentVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentFindFirst.mockResolvedValue({ simpleConfig: null, draftConfig: { name: "A", tone: "t" } });
    mocks.versionCreate.mockResolvedValue({});
    mocks.agentUpdate.mockResolvedValue({});
  });

  it("a primeira publicação não liga o agente: ligar é decisão separada", async () => {
    mocks.versionFindFirst.mockResolvedValue(null);
    const r = await publishV2AgentVersion("ag", "org", "u");
    expect(r.versionNumber).toBe(1);
    expect("active" in mocks.agentUpdate.mock.calls[0][0].data).toBe(false);
  });

  it("publicar de novo não religa um agente desligado", async () => {
    mocks.versionFindFirst.mockResolvedValue({ versionNumber: 3 });
    const r = await publishV2AgentVersion("ag", "org", "u");
    expect(r.versionNumber).toBe(4);
    expect("active" in mocks.agentUpdate.mock.calls[0][0].data).toBe(false);
  });
});

describe("ligar o agente", () => {
  const stored = (over: Record<string, unknown>) => ({ userId: "u-ai", simpleConfig: { name: "A", tone: "t", channelIds: [] }, active: false, ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentUpdate.mockResolvedValue({ id: "ag", simpleConfig: { name: "A", tone: "t" } });
  });

  it("sem número na versão publicada, só liga com confirmação", async () => {
    mocks.agentFindFirst.mockResolvedValue(stored({}));
    await expect(updateV2Agent("ag", "org", { active: true })).rejects.toBeInstanceOf(ActivationNeedsChannelError);
    expect(mocks.agentUpdate).not.toHaveBeenCalled();

    await updateV2Agent("ag", "org", { active: true, confirmAnyChannel: true });
    expect(mocks.agentUpdate.mock.calls[0][0].data.active).toBe(true);
  });

  it("com número escolhido liga direto; quem já está ligado, ou está desligando, não é barrado", async () => {
    mocks.agentFindFirst.mockResolvedValue(stored({ simpleConfig: { name: "A", tone: "t", channelIds: ["ch-1"] } }));
    await updateV2Agent("ag", "org", { active: true });
    mocks.agentFindFirst.mockResolvedValue(stored({ active: true }));
    await updateV2Agent("ag", "org", { active: true });
    mocks.agentFindFirst.mockResolvedValue(stored({ active: true }));
    await updateV2Agent("ag", "org", { active: false });
    expect(mocks.agentUpdate.mock.calls.map((c) => c[0].data.active)).toEqual([true, true, false]);
  });
});
