import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentKnowledgeDoc: {
      findFirst: mocks.findFirst,
      delete: mocks.delete,
    },
  },
}));

import { deleteKnowledgeDoc } from "@/services/ai/knowledge-docs";

describe("deleteKnowledgeDoc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("remove o documento e, em cascata, seus chunks de busca", async () => {
    mocks.findFirst.mockResolvedValue({ id: "doc-1" });
    mocks.delete.mockResolvedValue(undefined);

    await deleteKnowledgeDoc("agent-1", "doc-1");

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "doc-1", agentId: "agent-1" },
      select: { id: true },
    });
    expect(mocks.delete).toHaveBeenCalledWith({ where: { id: "doc-1" } });
  });

  it("não chama delete quando o documento não existe", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(deleteKnowledgeDoc("agent-1", "doc-2")).rejects.toThrow(
      "Documento não encontrado",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
