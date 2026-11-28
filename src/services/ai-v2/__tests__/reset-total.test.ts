import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  contactFindUnique: vi.fn(),
  agentFindMany: vi.fn(),
  convFindMany: vi.fn(),
  stateDeleteMany: vi.fn(async () => ({ count: 1 })),
  pendingUpdateMany: vi.fn(async () => ({ count: 0 })),
  pipelineFindFirst: vi.fn(),
  stageFindFirst: vi.fn(),
  dealFindMany: vi.fn(),
  dealFindFirst: vi.fn(),
  dealUpdate: vi.fn(async () => ({})),
  customFieldFindMany: vi.fn(),
  dcfvDeleteMany: vi.fn(async () => ({ count: 2 })),
  sendsUpdateMany: vi.fn(async () => ({ count: 1 })),
  schedUpdateMany: vi.fn(async () => ({ count: 1 })),
  messageCreate: vi.fn(async () => ({})),
  sendAgentMessage: vi.fn(async () => ({})),
  resolve: vi.fn(async () => ({})),
  events: vi.fn(async () => undefined),
  logTurn: vi.fn(async () => undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findUnique: m.contactFindUnique },
    aIAgentConfig: { findMany: m.agentFindMany },
    conversation: { findMany: m.convFindMany },
    aISimpleConversationState: { deleteMany: m.stateDeleteMany },
    distributionPending: { updateMany: m.pendingUpdateMany },
    pipeline: { findFirst: m.pipelineFindFirst },
    stage: { findFirst: m.stageFindFirst },
    deal: { findMany: m.dealFindMany, findFirst: m.dealFindFirst, update: m.dealUpdate },
    customField: { findMany: m.customFieldFindMany },
    dealCustomFieldValue: { deleteMany: m.dcfvDeleteMany },
    aIV2ScheduledSend: { updateMany: m.sendsUpdateMany },
    scheduledMessage: { updateMany: m.schedUpdateMany },
    message: { create: m.messageCreate },
  },
}));
vi.mock("@/lib/request-context", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/request-context")>()), getOrgIdOrNull: () => "org-1" }));
vi.mock("@/lib/cache", () => ({ cache: { tryClaim: vi.fn(async () => true) } }));
vi.mock("@/services/ai/turn-manager", () => ({ invalidateOpenTurns: vi.fn(async () => undefined) }));
vi.mock("@/services/ai/attendance-gate", () => ({ isAiAttendanceEnabled: vi.fn(async () => true) }));
vi.mock("@/services/ai/send-agent-message", () => ({ sendAgentMessage: m.sendAgentMessage }));
vi.mock("@/services/conversations", () => ({ resolveConversationsInline: m.resolve }));
vi.mock("@/services/deals", () => ({ createDealEventsMany: m.events }));
vi.mock("../log", () => ({ logV2Turn: m.logTurn }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageRowChange: vi.fn(async () => undefined) }));

import { handleV2ResetCommand, isV2ResetCommand, isV2ResetTotalCommand } from "../reset";

const AGENT_CONFIG = {
  allowedPhoneNumbers: ["5511999990000"],
  contextFields: { deal: [{ key: "curso_de_inscricao", permissions: ["read", "write"] }, { key: "title", permissions: ["write"] }, { key: "polo", permissions: ["read"] }] },
};

describe("#reset total (28/11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.contactFindUnique.mockResolvedValue({ phone: "5511999990000" });
    m.agentFindMany.mockResolvedValue([{ id: "cfg-1", userId: "agent-user", simpleConfig: AGENT_CONFIG, draftConfig: null }]);
    m.convFindMany.mockResolvedValue([{ id: "conv-1" }, { id: "conv-0" }]);
    m.pipelineFindFirst.mockResolvedValue({ id: "pipe-main" });
    m.stageFindFirst.mockResolvedValue({ id: "stage-first" });
    m.dealFindMany.mockResolvedValue([{ id: "deal-1", stageId: "stage-processo", status: "OPEN" }]);
    m.customFieldFindMany.mockResolvedValue([{ id: "cf-curso" }]);
  });

  it("reconhece os dois comandos", () => {
    expect(isV2ResetCommand("#reset")).toBe(true);
    expect(isV2ResetCommand("#Reset  Total.")).toBe(true);
    expect(isV2ResetTotalCommand("#reset total")).toBe(true);
    expect(isV2ResetTotalCommand("#reset")).toBe(false);
  });

  it("negócio volta à 1ª etapa, campos do agente limpos, agenda cancelada, marcador gravado", async () => {
    const ok = await handleV2ResetCommand({ conversationId: "conv-1", contactId: "c-1", messageId: "msg-1", channel: "meta", total: true });
    expect(ok).toBe(true);
    expect(m.dealUpdate).toHaveBeenCalledWith({ where: { id: "deal-1" }, data: { stageId: "stage-first", status: "OPEN", lostReason: null, closedAt: null } });
    expect((m.events.mock.calls as unknown as Array<[Array<Record<string, unknown>>]>)[0][0][0]).toMatchObject({ dealId: "deal-1", type: "STAGE_CHANGED", meta: { reason: "v2_reset_total" } });
    // Só o campo personalizado que o agente grava (nativo "title" e campo só de leitura ficam de fora).
    const cfWhere = ((m.customFieldFindMany.mock.calls as unknown as unknown[][])[0][0] as { where: { OR: unknown[] } }).where.OR;
    expect(JSON.stringify(cfWhere)).toContain("curso_de_inscricao");
    expect(JSON.stringify(cfWhere)).not.toContain("polo");
    expect(m.dcfvDeleteMany).toHaveBeenCalledWith({ where: { dealId: { in: ["deal-1"] }, customFieldId: { in: ["cf-curso"] } } });
    expect((m.sendsUpdateMany.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ where: { contactId: "c-1" }, data: { status: "CANCELLED" } });
    expect((m.schedUpdateMany.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ where: { conversationId: { in: ["conv-1", "conv-0"] }, status: "PENDING" } });
    expect((m.messageCreate.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ data: { messageType: "ai_v2_reset", isPrivate: true, conversationId: "conv-1" } });
    expect(((m.sendAgentMessage.mock.calls as unknown as unknown[][])[0][0] as { text: string }).text).toContain("Reset total: 1 negócio(s) na 1ª etapa");
    expect((m.logTurn.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ inboundText: "#reset total" });
    expect(m.resolve).toHaveBeenCalled();
  });

  it("#reset simples não mexe no negócio", async () => {
    await handleV2ResetCommand({ conversationId: "conv-1", contactId: "c-1", messageId: "msg-2", channel: "meta" });
    expect(m.dealUpdate).not.toHaveBeenCalled();
    expect(m.dcfvDeleteMany).not.toHaveBeenCalled();
    expect(m.messageCreate).not.toHaveBeenCalled();
  });

  it("número fora da lista de teste: nada acontece", async () => {
    m.contactFindUnique.mockResolvedValue({ phone: "5521988887777" });
    const ok = await handleV2ResetCommand({ conversationId: "conv-1", contactId: "c-1", messageId: "msg-3", channel: "meta", total: true });
    expect(ok).toBe(false);
    expect(m.dealUpdate).not.toHaveBeenCalled();
    expect(m.sendAgentMessage).not.toHaveBeenCalled();
  });
});
