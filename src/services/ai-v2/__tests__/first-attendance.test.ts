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
}));

vi.mock("@/lib/org-settings", () => ({ getOrgSetting: vi.fn(async () => null) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: mocks.convFindUnique },
    distributionPending: { findFirst: mocks.pendingFindFirst },
    user: { findMany: mocks.userFindMany },
    $transaction: async (fn: (tx: typeof mocks.tx) => Promise<void>) => fn(mocks.tx),
  },
}));
vi.mock("@/lib/channels/retired-whatsapp", () => ({ isRetiredWhatsAppChannel: () => false }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/services/ai/attendance-gate", () => ({
  isAiAttendanceEnabled: mocks.aiEnabled,
  releaseAiAssigneeIfDisabled: mocks.release,
}));
vi.mock("@/services/ai/phone-allowlist", () => ({ isContactAllowedForAi: async () => true }));
vi.mock("@/services/ai-v2/agent-resolver", () => ({
  conversationHandedOffToHuman: mocks.handedOff,
  pickAgentForConversation: (agents: Array<{ id: string }>) => agents[0] ?? null,
}));
vi.mock("@/services/distribution/human-assignment-history", () => ({ humanWasAssignedInThisConversation: mocks.assignedHere }));
vi.mock("@/services/distribution/return-after-close", () => ({ keepHumanAfterAutomationClose: async () => null }));
vi.mock("@/services/ai/idle-inbound", () => ({ shouldSkipIdleInboundAutomation: async () => false }));
vi.mock("@/services/automation-context", () => ({ getContactActiveContexts: mocks.activeContexts }));

import { tryAssignFirstAttendanceAi } from "../first-attendance";

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

describe("1º atendimento por agente v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aiEnabled.mockResolvedValue(true);
    mocks.handedOff.mockResolvedValue(false);
    mocks.assignedHere.mockResolvedValue(false);
    mocks.activeContexts.mockResolvedValue([]);
    mocks.convFindUnique.mockResolvedValue(conv());
    mocks.pendingFindFirst.mockResolvedValue(null);
    mocks.userFindMany.mockResolvedValue([{ id: "ai-1", aiAgentConfig: { id: "agent-1", simpleConfig: {} } }]);
  });

  it("sem dono, canal conectado, sem fila: atribui conversa, contato e negócios ao agente", async () => {
    const r = await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", assignedToId: null });
    expect(r).toBe("ai-1");
    expect(mocks.tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assignedToId: "ai-1" } }));
    expect(mocks.tx.contact.update).toHaveBeenCalled();
    expect(mocks.tx.deal.updateMany).toHaveBeenCalled();
  });

  it("transferida por um agente para pessoa e aberta: fica de pessoa, em qualquer horário", async () => {
    mocks.handedOff.mockResolvedValue(true);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.tx.conversation.update).not.toHaveBeenCalled();
  });

  it("pendente na fila de pessoas: não assume, sem exceções", async () => {
    mocks.pendingFindFirst.mockResolvedValue({ id: "pend-1", triggerSource: "AI_AGENT" });
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.tx.conversation.update).not.toHaveBeenCalled();
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
    expect(mocks.tx.conversation.update).not.toHaveBeenCalled();
    mocks.convFindUnique.mockResolvedValue(conv());
    mocks.activeContexts.mockResolvedValue([{ id: "ctx-1" }]);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
  });

  it("atendimento por IA desligado na org: solta a IA e não atribui", async () => {
    mocks.aiEnabled.mockResolvedValue(false);
    expect(await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1" })).toBeNull();
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });
});
