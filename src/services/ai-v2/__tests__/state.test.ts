import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aISimpleConversationState: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      update: mocks.update,
      create: mocks.create,
    },
  },
}));

import { upsertV2ConversationState } from "../state";

describe("upsertV2ConversationState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("estado existente passa a ser do agente que atende agora", async () => {
    const existing = { id: "st-1", conversationId: "c-1", agentId: "agent-0", stage: "active", owner: "pessoa", counters: {} };
    mocks.findUnique.mockResolvedValue(existing);
    mocks.findFirst.mockResolvedValue(existing);
    mocks.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...existing, ...args.data }));

    await upsertV2ConversationState({ organizationId: "org", conversationId: "c-1", agentId: "agent-1", owner: "agente" });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({ agentId: "agent-1", owner: "agente" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
