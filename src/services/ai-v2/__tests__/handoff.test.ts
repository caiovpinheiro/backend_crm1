import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Transferência da v2: um destino por tipo (departamento, pessoa, agente de
 * IA, regra de distribuição) e a saída quando o destino falha. Sem regra de
 * produto: a rota é só a da configuração.
 */

const mocks = vi.hoisted(() => ({
  executeDistribution: vi.fn(async (_args: Record<string, unknown>) => undefined),
  conversationUpdateMany: vi.fn(async (_args: { where: unknown; data: { assignedToId: unknown } }) => ({ count: 1 })),
  conversationUpdate: vi.fn(async (_args: unknown) => ({})),
  agentFindUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
  ruleFindUnique: vi.fn(async (_args: unknown): Promise<unknown> => null),
  ruleUpdate: vi.fn(async (_args: unknown) => ({})),
  isAgentAvailable: vi.fn(async (_userId: string) => true),
  requeueTurn: vi.fn(async (_turnId: string) => undefined),
  traceStep: vi.fn((_step: string, _detail: string) => undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { updateMany: mocks.conversationUpdateMany, update: mocks.conversationUpdate },
    aIAgentConfig: { findUnique: mocks.agentFindUnique },
    distributionRule: { findUnique: mocks.ruleFindUnique, update: mocks.ruleUpdate },
  },
}));
vi.mock("@/services/distribution", () => ({ executeDistribution: mocks.executeDistribution }));
vi.mock("@/services/lead-distribution", () => ({ isAgentAvailable: mocks.isAgentAvailable }));
vi.mock("@/services/ai/turn-manager", () => ({ requeueTurnForAssignee: mocks.requeueTurn }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("../trace", () => ({ traceStep: mocks.traceStep }));

import { simpleHandoff } from "../handoff";

const released = () => mocks.conversationUpdateMany.mock.calls.some((c) => c[0].data.assignedToId === null);

describe("transferência resiliente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAgentAvailable.mockResolvedValue(true);
    mocks.executeDistribution.mockResolvedValue(undefined);
  });

  it("distribuição fora do ar: não derruba o turno e devolve a conversa à fila da equipe", async () => {
    mocks.executeDistribution.mockRejectedValue(new Error("distribuição indisponível"));
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "department", id: "dep-1" } })).resolves.toBeUndefined();
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "conv-1" }), data: { assignedToId: null } }));
    expect(mocks.traceStep).toHaveBeenCalledWith("transferência", expect.stringContaining("falhou"));
  });

  it("destino sem id (usuário apagado da configuração): mesma saída, sem exceção", async () => {
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "user" } })).resolves.toBeUndefined();
    expect(mocks.conversationUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.executeDistribution).not.toHaveBeenCalled();
  });

  it("caminho normal: distribui e libera a conversa da IA", async () => {
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "department", id: "dep-1" } });
    expect(mocks.executeDistribution).toHaveBeenCalledTimes(1);
    expect(mocks.conversationUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("rota por tipo de destino", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAgentAvailable.mockResolvedValue(true);
    mocks.executeDistribution.mockResolvedValue(undefined);
  });

  it("departamento: distribuição no departamento, origem AI_AGENT, sem cair em toda a organização", async () => {
    await simpleHandoff({ conversationId: "conv-1", contactId: "ct-1", dealId: "deal-1", destination: { type: "department", id: "dep-1" } });
    expect(mocks.executeDistribution).toHaveBeenCalledWith({
      conversationId: "conv-1",
      contactId: "ct-1",
      dealId: "deal-1",
      triggerSource: "AI_AGENT",
      departmentId: "dep-1",
      reassign: true,
      allowOrgWideFallback: false,
    });
    expect(released()).toBe(true);
  });

  it("pessoa: atribui direto e não passa pela distribuição", async () => {
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "user", id: "u-7" } });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "u-7" } });
    expect(mocks.executeDistribution).not.toHaveBeenCalled();
  });

  it("agente de IA: atribui ao usuário do agente, não solta da IA e reaproveita o turno em andamento", async () => {
    mocks.agentFindUnique.mockResolvedValue({ userId: "ai-user-2", engine: "simple", active: true });
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "ai_agent", id: "agent-2" }, turnId: "turn-9" });
    expect(mocks.agentFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "agent-2" } }));
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "ai-user-2" } });
    expect(released()).toBe(false);
    expect(mocks.requeueTurn).toHaveBeenCalledWith("turn-9");
    expect(mocks.traceStep).not.toHaveBeenCalled();
  });

  it("agente de IA sem turno em andamento: não cria turno; falha ao reenfileirar não derruba", async () => {
    mocks.agentFindUnique.mockResolvedValue({ userId: "ai-user-2", engine: "simple", active: true });
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "ai_agent", id: "agent-2" } });
    expect(mocks.requeueTurn).not.toHaveBeenCalled();

    mocks.requeueTurn.mockRejectedValueOnce(new Error("fila indisponível"));
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "ai_agent", id: "agent-2" }, turnId: "turn-1" })).resolves.toBeUndefined();
    expect(mocks.conversationUpdate).toHaveBeenCalledTimes(2);
  });

  it("agente de IA de destino desligado ou de outro motor: atribui, mas avisa no rastro", async () => {
    mocks.agentFindUnique.mockResolvedValue({ userId: "ai-user-3", engine: "legacy", active: false });
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "ai_agent", id: "agent-3" } });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "ai-user-3" } });
    const traces = mocks.traceStep.mock.calls.map((c) => String(c[1]));
    expect(traces.some((t) => t.includes("motor antigo"))).toBe(true);
    expect(traces.some((t) => t.includes("desligado"))).toBe(true);
  });

  it("agente de IA apagado: conversa vai para a fila da equipe, sem exceção", async () => {
    mocks.agentFindUnique.mockResolvedValue(null);
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "ai_agent", id: "agent-x" } })).resolves.toBeUndefined();
    expect(mocks.conversationUpdate).not.toHaveBeenCalled();
    expect(released()).toBe(true);
    expect(mocks.traceStep).toHaveBeenCalledWith("transferência", expect.stringContaining("não encontrado"));
  });

  it("regra de distribuição em rodízio: pula quem está indisponível e grava a posição", async () => {
    mocks.ruleFindUnique.mockResolvedValue({
      id: "rule-1",
      mode: "ROUND_ROBIN",
      lastIndex: 0,
      members: [{ userId: "u-1" }, { userId: "u-2" }, { userId: "u-3" }],
    });
    mocks.isAgentAvailable.mockImplementation(async (userId: string) => userId === "u-3");
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "distribution_rule", id: "rule-1" } });
    expect(mocks.isAgentAvailable.mock.calls.map((c) => c[0])).toEqual(["u-2", "u-3"]);
    expect(mocks.ruleUpdate).toHaveBeenCalledWith({ where: { id: "rule-1" }, data: { lastIndex: 2 } });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "u-3" } });
    expect(mocks.executeDistribution).not.toHaveBeenCalled();
  });

  it("regra de distribuição em rodízio: dá a volta completa a partir da última posição", async () => {
    mocks.ruleFindUnique.mockResolvedValue({
      id: "rule-1",
      mode: "ROUND_ROBIN",
      lastIndex: 2,
      members: [{ userId: "u-1" }, { userId: "u-2" }, { userId: "u-3" }],
    });
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "distribution_rule", id: "rule-1" } });
    expect(mocks.ruleUpdate).toHaveBeenCalledWith({ where: { id: "rule-1" }, data: { lastIndex: 0 } });
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "u-1" } });
  });

  it("regra de distribuição sem rodízio: primeiro membro disponível, sem gravar posição", async () => {
    mocks.ruleFindUnique.mockResolvedValue({
      id: "rule-2",
      mode: "FIRST_AVAILABLE",
      lastIndex: 5,
      members: [{ userId: "u-1" }, { userId: "u-2" }],
    });
    mocks.isAgentAvailable.mockImplementation(async (userId: string) => userId === "u-2");
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "distribution_rule", id: "rule-2" } });
    expect(mocks.ruleUpdate).not.toHaveBeenCalled();
    expect(mocks.conversationUpdate).toHaveBeenCalledWith({ where: { id: "conv-1" }, data: { assignedToId: "u-2" } });
  });

  it("regra de distribuição sem ninguém disponível (ou sem membros, ou apagada): fila da equipe sem departamento", async () => {
    mocks.ruleFindUnique.mockResolvedValue({ id: "rule-1", mode: "ROUND_ROBIN", lastIndex: 0, members: [{ userId: "u-1" }] });
    mocks.isAgentAvailable.mockResolvedValue(false);
    await simpleHandoff({ conversationId: "conv-1", contactId: "ct-1", destination: { type: "distribution_rule", id: "rule-1" } });
    expect(mocks.conversationUpdate).not.toHaveBeenCalled();
    expect(mocks.executeDistribution).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", contactId: "ct-1", triggerSource: "AI_AGENT", reassign: true, allowOrgWideFallback: false }));
    expect(mocks.executeDistribution.mock.calls[0][0]).not.toHaveProperty("departmentId");

    mocks.ruleFindUnique.mockResolvedValue({ id: "rule-1", mode: "ROUND_ROBIN", lastIndex: 0, members: [] });
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "distribution_rule", id: "rule-1" } });
    mocks.ruleFindUnique.mockResolvedValue(null);
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "distribution_rule", id: "rule-1" } });
    expect(mocks.executeDistribution).toHaveBeenCalledTimes(3);
    expect(mocks.ruleUpdate).not.toHaveBeenCalled();
  });

  it("regra de distribuição sem id: fila da equipe sem exceção", async () => {
    await expect(simpleHandoff({ conversationId: "conv-1", destination: { type: "distribution_rule" } })).resolves.toBeUndefined();
    expect(mocks.ruleFindUnique).not.toHaveBeenCalled();
    expect(released()).toBe(true);
  });

  it("tipo desconhecido (fluxo de automação, por exemplo): por segurança, fila da equipe", async () => {
    await simpleHandoff({ conversationId: "conv-1", destination: { type: "automation" as never, id: "auto-1" } });
    expect(mocks.executeDistribution).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", triggerSource: "AI_AGENT" }));
    expect(mocks.executeDistribution.mock.calls[0][0]).not.toHaveProperty("departmentId");
    expect(released()).toBe(true);
  });
});
