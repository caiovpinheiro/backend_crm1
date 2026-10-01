import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), schedule: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentKnowledgeDoc: { findMany: mocks.findMany },
  },
}));
vi.mock("@/services/ai/embeddings", () => ({ scheduleIndexing: mocks.schedule }));

import * as docs from "@/services/ai/knowledge-docs";

describe("healLegacyKnowledgeDocs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("busca só materiais prontos salvos como payload JSON e roda uma vez por agente", async () => {
    mocks.findMany.mockResolvedValue([]);
    await docs.healLegacyKnowledgeDocs("agent-heal-1");
    await docs.healLegacyKnowledgeDocs("agent-heal-1");

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      agentId: "agent-heal-1",
      status: "READY",
      content: { startsWith: '{"type"' },
    });
  });
});
