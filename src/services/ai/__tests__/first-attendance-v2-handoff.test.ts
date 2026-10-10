import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 1º atendimento por IA em cima de uma conversa que um agente v2 já
 * transferiu para pessoa (ticket pendente na fila): fora do horário de
 * pessoas, a exceção antiga mandava a IA assumir — outro agente respondia
 * "posso ajudar em mais alguma coisa?" para quem só disse "obrigada, fico
 * no aguardo". A fila vale até a conversa encerrar.
 */

const mocks = vi.hoisted(() => ({
  convFindUnique: vi.fn(),
  pendingFindFirst: vi.fn(),
  userFindFirst: vi.fn(async () => null),
  agentFindFirst: vi.fn(async () => null),
  handedOff: vi.fn(async () => false),
}));

vi.mock("@/lib/org-settings", () => ({ getOrgSetting: vi.fn(async () => null) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: mocks.convFindUnique },
    distributionPending: { findFirst: mocks.pendingFindFirst },
    user: { findFirst: mocks.userFindFirst },
    aIAgentConfig: { findFirst: mocks.agentFindFirst },
  },
}));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/lib/channels/retired-whatsapp", () => ({ isRetiredWhatsAppChannel: () => false }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getRequestContext: () => null }));
vi.mock("@/services/ai/attendance-gate", () => ({
  isAiAttendanceEnabled: async () => true,
  releaseAiAssigneeIfDisabled: async () => false,
}));
vi.mock("@/services/ai/phone-allowlist", () => ({ isContactAllowedForAi: async () => true }));
vi.mock("@/services/distribution/human-assignment-history", () => ({ humanWasAssignedInThisConversation: async () => false }));
vi.mock("@/services/distribution/return-after-close", () => ({ keepHumanAfterAutomationClose: async () => null }));
// Fora do horário de pessoas: a exceção antiga manteria a IA.
vi.mock("@/services/ai/human-queue-policy", () => ({
  humanQueueContextFromAgent: () => ({}),
  isHumanAttendanceWindowOpen: () => false,
}));
vi.mock("@/services/ai/agent-vertical", () => ({
  emptyAgentVertical: () => ({ ops: {}, inboxPolicy: null, businessHours: null }),
  resolveAgentVerticalByAgentUserId: async () => ({ ops: {}, inboxPolicy: null, businessHours: null }),
}));
vi.mock("@/services/ai/idle-inbound", () => ({ shouldSkipIdleInboundAutomation: async () => false }));
vi.mock("@/services/automation-context", () => ({ getContactActiveContexts: async () => [] }));
vi.mock("@/services/ai-v2/agent-resolver", () => ({ conversationHandedOffToHuman: mocks.handedOff }));

import { tryAssignFirstAttendanceAi } from "@/services/ai/first-attendance";

describe("1º atendimento por IA x conversa transferida para pessoa por agente v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.convFindUnique.mockImplementation(async (args: { select?: { channelRef?: unknown } }) =>
      args?.select?.channelRef
        ? { channelRef: { status: "CONNECTED", name: "Canal", phoneNumber: null, config: null } }
        : { assignedToId: null, contactId: "ct-1", hasHumanReply: false, departmentId: "dep-1", aiGreetedAt: null, closedAt: null, assignedTo: null },
    );
    mocks.pendingFindFirst.mockResolvedValue({ id: "pend-1", triggerSource: "AI_AGENT" });
  });

  it("transferida por agente v2 e pendente na fila: a IA não assume, mesmo fora do horário", async () => {
    mocks.handedOff.mockResolvedValue(true);
    const r = await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", assignedToId: null });
    expect(r).toBeNull();
    expect(mocks.handedOff).toHaveBeenCalledWith({ id: "conv-1", closedAt: null });
    expect(mocks.agentFindFirst).not.toHaveBeenCalled();
  });

  it("pendência que não veio de agente v2 segue a regra de sempre (passa pela exceção de horário)", async () => {
    mocks.handedOff.mockResolvedValue(false);
    await tryAssignFirstAttendanceAi({ conversationId: "conv-1", contactId: "ct-1", assignedToId: null });
    expect(mocks.agentFindFirst).toHaveBeenCalled();
  });
});
