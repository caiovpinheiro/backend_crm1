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

import { publishV2AgentVersion } from "../agents";

describe("publishV2AgentVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentFindFirst.mockResolvedValue({ simpleConfig: null, draftConfig: { name: "A", tone: "t" } });
    mocks.versionCreate.mockResolvedValue({});
    mocks.agentUpdate.mockResolvedValue({});
  });

  it("a primeira publicação liga o agente", async () => {
    mocks.versionFindFirst.mockResolvedValue(null);
    const r = await publishV2AgentVersion("ag", "org", "u");
    expect(r.versionNumber).toBe(1);
    expect(mocks.agentUpdate.mock.calls[0][0].data.active).toBe(true);
  });

  it("publicar de novo não religa um agente desligado", async () => {
    mocks.versionFindFirst.mockResolvedValue({ versionNumber: 3 });
    const r = await publishV2AgentVersion("ag", "org", "u");
    expect(r.versionNumber).toBe(4);
    expect("active" in mocks.agentUpdate.mock.calls[0][0].data).toBe(false);
  });
});
