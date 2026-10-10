import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 1º atendimento por agente v2: conversa sem dono vai para o agente do
 * canal, salvo quando é de pessoa (transferida e aberta, pendente na fila,
 * humano que já falou ou foi atribuído nela). Sem regra de produto.
 */

const mocks = vi.hoisted(() => ({
  convFindUnique: vi.fn(),
  pendingFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  tx: { conversation: { update: vi.fn() }, contact: { update: vi.fn() }, deal: { updateMany: vi.fn() } },
  aiEnabled: vi.fn(async () => true),
  release: vi.fn(async () => false),
  handedOff: vi.fn(async () => false),
  assignedHere: vi.fn(async () => false),
  activeContexts: vi.fn(async (): Promise<unknown[]> => []),
  orgSetting: vi.fn(async (_key: string): Promise<string | null> => null),
  idleInbound: vi.fn(async () => false),
  allowed: vi.fn(async () => true),
  keepHuman: vi.fn(async (): Promise<string | null> => null),
  retired: vi.fn(() => false),
  pickAgent: vi.fn((agents: Array<{ id: string }>, _channelId: string | null, _phone: string | null): { id: string } | null => agents[0] ?? null),
  distribute: vi.fn(async () => undefined),
}));

vi.mock("@/lib/org-settings", () => ({ getOrgSetting: mocks.orgSetting }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: mocks.convFindUnique },
    distributionPending: { findFirst: mocks.pendingFindFirst },
    user: { findMany: mocks.userFindMany },
    $transaction: async (fn: (tx: typeof mocks.tx) => Promise<void>) => fn(mocks.tx),
  },
}));
vi.mock("@/lib/channels/retired-whatsapp", () => ({ isRetiredWhatsAppChannel: mocks.retired }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/services/ai/attendance-gate", () => ({
  isAiAttendanceEnabled: mocks.aiEnabled,
  releaseAiAssigneeIfDisabled: mocks.release,
}));
vi.mock("@/services/ai/phone-allowlist", () => ({ isContactAllowedForAi: mocks.allowed }));
vi.mock("@/services/ai-v2/agent-resolver", () => ({
  conversationHandedOffToHuman: mocks.handedOff,
  pickAgentForConversation: mocks.pickAgent,
}));
vi.mock("@/services/distribution/human-assignment-history", () => ({ humanWasAssignedInThisConversation: mocks.assignedHere }));
vi.mock("@/services/distribution/return-after-close", () => ({ keepHumanAfterAutomationClose: mocks.keepHuman }));
vi.mock("@/services/ai/idle-inbound", () => ({ shouldSkipIdleInboundAutomation: mocks.idleInbound }));
vi.mock("@/services/automation-context", () => ({ getContactActiveContexts: mocks.activeContexts }));
vi.mock("@/services/distribution", () => ({ maybeDistributeNewInboundTicket: mocks.distribute }));

import { ensureInboundAiAttendance, tryAssignFirstAttendanceAi } from "../first-attendance";

const conv = (over: Record<string, unknown> = {}) => ({
  id: "conv-1",
  organizationId: "org-1",
  assignedToId: null,
  contactId: "ct-1",
  hasHumanReply: false,
  closedAt: null,
  channelId: "ch-1",
  contact: { phone: "5511988887777" },
  channelRef: { status: "CONNECTED", name: "Canal", phoneNumber: null, config: null },
  assignedTo: null,
  ...over,
});

const assigned = () => mocks.tx.conversation.update.mock.calls.length > 0;

describe("1º atendimento por agente v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aiEnabled.mockResolvedValue(true);
    mocks.handedOff.mockResolvedValue(false);
    mocks.assignedHere.mockResolvedValue(false);
    mocks.activeContexts.mockResolvedValue([]);
    mocks.orgSetting.mockResolvedValue(null);
    mocks.idleInbound.mockResolvedValue(false);
    mocks.allowed.mockResolvedValue(true);
    mocks.keepHuman.mockResolvedValue(null);
    mocks.retired.mockReturnValue(false);
    mocks.pickAgent.mockImplementation((agents: Array<{ id: string }>) => agents[0] ?? null);
    mocks.convFindUnique.mockResolvedValue(conv());
    mocks.pendingFindFirst.mockResolvedValue(null);
    mocks.userFindMany.mockResolvedValue([{ id: "ai-1", aiAgentConfig: { id: "agent-1", simpleConfig: {} } }]);
  });

  it("sem dono, canal conectado, sem fila: atribui conversa, contato e negócios ao agente", async () => {
    const r = await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", assignedToId: null });
    expect(r).toBe("ai-1");
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assignedToId: "ai-1" } }));
    expect(mocks.tx.contact.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ct-1" }, data: { assignedToId: "ai-1" } }));
    expect(mocks.tx.deal.updateMany).toHaveBeenCalledWith({ where: { contactId: "ct-1", status: "OPEN" }, data: { ownerId: "ai-1" } });
    // Só agentes ativos do motor v2 entram na escolha, pelo canal e telefone da conversa.
    expect(mocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: "org-1", type: "AI", aiAgentConfig: { is: { active: true, engine: "simple" } } },
    }));
    expect(mocks.pickAgent).toHaveBeenCalledWith(expect.any(Array), "ch-1", "5511988887777");
  });

  it("transferida por um agente para pessoa e aberta: fica de pessoa, em qualquer horário", async () => {
    mocks.handedOff.mockResolvedValue(true);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(assigned()).toBe(false);
  });

  it("pendente na fila de pessoas: não assume, sem exceções", async () => {
    mocks.pendingFindFirst.mockResolvedValue({ id: "pend-1", triggerSource: "AI_AGENT" });
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(assigned()).toBe(false);
    expect(mocks.pendingFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "PENDING", OR: [{ conversationId: "conv-1" }, { contactId: "ct-1" }] },
    }));
  });

  it("humano: já falou ou foi atribuído nesta conversa → fica; herança antiga sem fala → a IA assume", async () => {
    mocks.convFindUnique.mockResolvedValue(conv({ assignedToId: "h-1", assignedTo: { type: "HUMAN" }, hasHumanReply: true }));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    mocks.convFindUnique.mockResolvedValue(conv({ assignedToId: "h-1", assignedTo: { type: "HUMAN" } }));
    mocks.assignedHere.mockResolvedValue(true);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    mocks.assignedHere.mockResolvedValue(false);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBe("ai-1");
  });

  it("já está com um agente de IA: devolve o mesmo, sem mexer; fluxo pausado aguardando resposta: não assume", async () => {
    mocks.convFindUnique.mockResolvedValue(conv({ assignedToId: "ai-9", assignedTo: { type: "AI" } }));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBe("ai-9");
    expect(assigned()).toBe(false);
    mocks.convFindUnique.mockResolvedValue(conv());
    mocks.activeContexts.mockResolvedValue([{ id: "ctx-1" }]);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
  });

  it("consulta dos fluxos falhou: não assume (em vez de atropelar um fluxo que pode estar esperando)", async () => {
    mocks.activeContexts.mockRejectedValue(new Error("db"));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(assigned()).toBe(false);
  });

  it("atendimento por IA desligado na org: solta a IA e não atribui", async () => {
    mocks.aiEnabled.mockResolvedValue(false);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("1º atendimento desligado pela chave da org (false/0/off/no): não atribui; vazio ou outro valor: ligado", async () => {
    for (const v of ["false", "0", "off", "NO", " false "]) {
      mocks.orgSetting.mockResolvedValue(v);
      expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    }
    expect(mocks.convFindUnique).not.toHaveBeenCalled();
    for (const v of ["", "true", "1", "sim"]) {
      mocks.orgSetting.mockResolvedValue(v);
      expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBe("ai-1");
    }
    expect(mocks.orgSetting).toHaveBeenCalledWith("ai.firstAttendanceEnabled");
    // Falha ao ler a chave: fica ligado.
    mocks.orgSetting.mockRejectedValue(new Error("db"));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBe("ai-1");
  });

  it("mensagem solta de cortesia (ok, obrigado): não abre atendimento de IA; sem mensagem, não consulta", async () => {
    mocks.idleInbound.mockResolvedValue(true);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", userMessage: "ok" })).toBeNull();
    expect(mocks.convFindUnique).not.toHaveBeenCalled();
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", userMessage: "  " })).toBe("ai-1");
    expect(mocks.idleInbound).toHaveBeenCalledTimes(1);
    // Falha na checagem não impede o atendimento.
    mocks.idleInbound.mockRejectedValue(new Error("x"));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", userMessage: "oi" })).toBe("ai-1");
  });

  it("contato fora da lista permitida para IA (ou lista indisponível): não assume", async () => {
    mocks.allowed.mockResolvedValue(false);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    mocks.allowed.mockRejectedValue(new Error("x"));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.convFindUnique).not.toHaveBeenCalled();
  });

  it("pessoa mantida após encerramento por fluxo de automação: não assume; falha nessa checagem não impede", async () => {
    mocks.keepHuman.mockResolvedValue("h-5");
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.convFindUnique).not.toHaveBeenCalled();
    mocks.keepHuman.mockRejectedValue(new Error("x"));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBe("ai-1");
  });

  it("conversa inexistente ou sem contato: nada", async () => {
    mocks.convFindUnique.mockResolvedValue(null);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-x", contactId: "ct-1" })).toBeNull();
    mocks.convFindUnique.mockResolvedValue(conv({ contactId: null }));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "" })).toBeNull();
    expect(assigned()).toBe(false);
  });

  it("canal aposentado ou desconectado: não assume", async () => {
    mocks.retired.mockReturnValue(true);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    mocks.retired.mockReturnValue(false);
    mocks.convFindUnique.mockResolvedValue(conv({ channelRef: { status: "DISCONNECTED", name: "Canal", phoneNumber: null, config: null } }));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    // Sem canal vinculado (conversa antiga): segue.
    mocks.convFindUnique.mockResolvedValue(conv({ channelRef: null, channelId: null }));
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBe("ai-1");
    expect(mocks.pickAgent).toHaveBeenLastCalledWith(expect.any(Array), null, "5511988887777");
  });

  it("nenhum agente v2 ativo para o canal: não atribui", async () => {
    mocks.pickAgent.mockReturnValue(null);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(assigned()).toBe(false);
  });
});

describe("garantia do 1º atendimento a cada mensagem recebida", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aiEnabled.mockResolvedValue(true);
    mocks.handedOff.mockResolvedValue(false);
    mocks.assignedHere.mockResolvedValue(false);
    mocks.activeContexts.mockResolvedValue([]);
    mocks.orgSetting.mockResolvedValue(null);
    mocks.idleInbound.mockResolvedValue(false);
    mocks.allowed.mockResolvedValue(true);
    mocks.keepHuman.mockResolvedValue(null);
    mocks.retired.mockReturnValue(false);
    mocks.pickAgent.mockImplementation((agents: Array<{ id: string }>) => agents[0] ?? null);
    mocks.convFindUnique.mockResolvedValue(conv());
    mocks.pendingFindFirst.mockResolvedValue(null);
    mocks.userFindMany.mockResolvedValue([{ id: "ai-1", aiAgentConfig: { id: "agent-1", simpleConfig: {} } }]);
  });

  it("com a IA ligada: mesmo caminho do 1º atendimento, com a mensagem recebida", async () => {
    expect(await ensureInboundAiAttendance({ conversationId: "conv-1", contactId: "ct-1", userMessage: "oi" })).toBe("ai-1");
    expect(mocks.idleInbound).toHaveBeenCalledWith({ content: "oi" });
    expect(mocks.distribute).not.toHaveBeenCalled();
  });

  it("com a IA desligada na org: solta a IA e manda o ticket para a distribuição de pessoas", async () => {
    mocks.aiEnabled.mockResolvedValue(false);
    expect(await ensureInboundAiAttendance({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.release).toHaveBeenCalledWith({ conversationId: "conv-1", contactId: "ct-1" });
    expect(mocks.distribute).toHaveBeenCalledWith({ conversationId: "conv-1", contactId: "ct-1", assignedToId: null });
  });

  it("erro inesperado não derruba o recebimento da mensagem", async () => {
    mocks.convFindUnique.mockRejectedValue(new Error("db"));
    await expect(ensureInboundAiAttendance({ conversationId: "conv-1", contactId: "ct-1" })).resolves.toBeNull();
  });
});
