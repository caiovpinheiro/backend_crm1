import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeDistribution: vi.fn(),
  conversationUpdateMany: vi.fn(async () => ({ count: 1 })),
  conversationUpdate: vi.fn(async () => ({})),
  agentFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { updateMany: mocks.conversationUpdateMany, update: mocks.conversationUpdate },
    aIAgentConfig: { findUnique: mocks.agentFindUnique },
  },
}));
vi.mock("@/services/distribution", () => ({ executeDistribution: mocks.executeDistribution }));
vi.mock("@/services/lead-distribution", () => ({ isAgentAvailable: vi.fn(async () => true) }));

import { simpleHandoff } from "../handoff";

describe("transferência resiliente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("distribuição fora do ar: não derruba o turno e devolve a conversa à fila da equipe", async () => {
    mocks.executeDistribution.mockRejectedValue(new Error("distribuição indisponível"));
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "department", id: "dep-1" } })).resolves.toBeUndefined();
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "conv-1" }), data: { assignedToId: null } }));
  });

  it("destino sem id (usuário apagado da configuração): mesma saída, sem exceção", async () => {
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "user" } })).resolves.toBeUndefined();
    expect(mocks.conversationUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.executeDistribution).not.toHaveBeenCalled();
  });

  it("caminho normal: distribui e libera a conversa da IA", async () => {
    mocks.executeDistribution.mockResolvedValue(undefined);
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "department", id: "dep-1" } });
    expect(mocks.executeDistribution).toHaveBeenCalledTimes(1);
    expect(mocks.conversationUpdateMany).toHaveBeenCalledTimes(1);
  });
});
