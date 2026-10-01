import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  docFindMany: vi.fn(),
  docFindFirst: vi.fn(),
  docUpdate: vi.fn(),
  agentFindFirst: vi.fn(),
  agentFindUnique: vi.fn(),
  scheduleIndexing: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentKnowledgeDoc: { findMany: mocks.docFindMany, findFirst: mocks.docFindFirst, update: mocks.docUpdate },
    aIAgentKnowledgeChunk: { findMany: vi.fn().mockResolvedValue([]) },
    aIAgentConfig: { findFirst: mocks.agentFindFirst, findUnique: mocks.agentFindUnique },
  },
}));

vi.mock("@/services/ai/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/embeddings")>()),
  scheduleIndexing: mocks.scheduleIndexing,
}));

import { reindexFailedKnowledgeDocs } from "@/services/ai/knowledge-docs";

const doc = (id: string, content: string) => ({
  id,
  title: `Material ${id}`,
  content,
  status: "FAILED",
  errorMessage: "sem chave",
  validFrom: null,
  validUntil: null,
  expiredBehavior: "instruct",
  expiredInstruction: null,
});

describe("reindexFailedKnowledgeDocs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const agent = { simpleConfig: null, draftConfig: null, businessHours: null };
    mocks.agentFindFirst.mockResolvedValue(agent);
    mocks.agentFindUnique.mockResolvedValue(agent);
    mocks.docUpdate.mockImplementation(async ({ where }: { where: { id: string } }) => ({ ...doc(where.id, "x"), status: "PENDING", errorMessage: null }));
  });

  it("só os materiais com falha voltam para a fila, sem mexer no texto", async () => {
    mocks.docFindMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
    mocks.docFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => doc(where.id, `texto de ${where.id}`));

    const done = await reindexFailedKnowledgeDocs("ag-1");

    expect(mocks.docFindMany.mock.calls[0][0].where).toEqual({ agentId: "ag-1", status: "FAILED" });
    expect(done).toBe(2);
    expect(mocks.docUpdate.mock.calls.map((c) => c[0].data.status)).toEqual(["PENDING", "PENDING"]);
    expect(mocks.scheduleIndexing.mock.calls).toEqual([
      ["d1", "texto de d1"],
      ["d2", "texto de d2"],
    ]);
  });

  it("um material sem texto não impede os outros", async () => {
    mocks.docFindMany.mockResolvedValue([{ id: "vazio" }, { id: "d2" }]);
    mocks.docFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => doc(where.id, where.id === "vazio" ? "" : "texto"));

    const done = await reindexFailedKnowledgeDocs("ag-1");

    expect(done).toBe(1);
    expect(mocks.scheduleIndexing.mock.calls).toEqual([["d2", "texto"]]);
  });

  it("sem materiais com falha, não faz nada", async () => {
    mocks.docFindMany.mockResolvedValue([]);
    expect(await reindexFailedKnowledgeDocs("ag-1")).toBe(0);
    expect(mocks.scheduleIndexing).not.toHaveBeenCalled();
  });
});
