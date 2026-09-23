import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contactFindUnique: vi.fn(),
  agentFindMany: vi.fn(),
  agentFindFirst: vi.fn(),
  conversationFindMany: vi.fn(),
  stateDeleteMany: vi.fn(),
  logFindMany: vi.fn(),
  logFindFirst: vi.fn(),
  logUpdate: vi.fn(),
  docFindMany: vi.fn(),
  sendAgentMessage: vi.fn(),
  resolveInline: vi.fn(),
  invalidateOpenTurns: vi.fn(),
  logV2Turn: vi.fn(),
  operator: vi.fn(),
  attendance: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findUnique: mocks.contactFindUnique },
    aIAgentConfig: { findMany: mocks.agentFindMany, findFirst: mocks.agentFindFirst },
    conversation: { findMany: mocks.conversationFindMany },
    aISimpleConversationState: { deleteMany: mocks.stateDeleteMany },
    aISimpleTurnLog: { findMany: mocks.logFindMany, findFirst: mocks.logFindFirst, update: mocks.logUpdate },
    aIAgentKnowledgeDoc: { findMany: mocks.docFindMany },
  },
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1" }));
vi.mock("@/lib/cache", () => ({ cache: { tryClaim: vi.fn().mockResolvedValue(true) } }));
vi.mock("@/services/ai/phone-allowlist", () => {
  const normalizePhoneDigits = (raw: string | null | undefined) => {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
    return d;
  };
  return {
    normalizePhoneDigits,
    phoneMatchesAllowlist: (phone: string | null, allow: Set<string>) => {
      const n = normalizePhoneDigits(phone);
      return !!n && [...allow].some((p) => p && (n === p || n.endsWith(p) || p.endsWith(n)));
    },
  };
});
vi.mock("@/services/ai/test-mode", () => ({ resolveTestModeOperator: mocks.operator }));
vi.mock("@/services/ai/turn-manager", () => ({ invalidateOpenTurns: mocks.invalidateOpenTurns }));
vi.mock("@/services/ai/attendance-gate", () => ({ isAiAttendanceEnabled: mocks.attendance }));
vi.mock("@/services/ai/piloting-actions", () => ({ sendAgentMessage: mocks.sendAgentMessage }));
vi.mock("@/services/conversations", () => ({ resolveConversationsInline: mocks.resolveInline }));
vi.mock("../log", () => ({ logV2Turn: mocks.logV2Turn }));
vi.mock("../ensure-schema", () => ({ ensureV2AgentSchema: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: mocks.generate }));
vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn().mockResolvedValue("k") }));

import { handleV2ResetCommand, isV2ResetCommand } from "../reset";
import { listV2TestConversations } from "../test-logs";
import { diagnoseV2Turn } from "../diagnose";
import { runWithV2Trace, takeV2TraceForLog, traceStep } from "../trace";

const TEST_AGENT = { id: "agent-1", userId: "ai-1", simpleConfig: { name: "A", tone: "Objetivo", allowedPhoneNumbers: ["5511911112222"] } };

describe("#reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentFindMany.mockResolvedValue([TEST_AGENT]);
    mocks.conversationFindMany.mockResolvedValue([{ id: "conv-1" }, { id: "conv-old" }]);
    mocks.stateDeleteMany.mockResolvedValue({ count: 2 });
    mocks.operator.mockResolvedValue(null);
    mocks.attendance.mockResolvedValue(true);
    mocks.sendAgentMessage.mockResolvedValue({ status: "sent", messageId: "m" });
    mocks.resolveInline.mockResolvedValue({ updated: 1, missing: 0 });
    mocks.logV2Turn.mockResolvedValue(undefined);
  });

  it("reconhece só o comando exato", () => {
    expect(isV2ResetCommand("#reset")).toBe(true);
    expect(isV2ResetCommand(" #RESET! ")).toBe(true);
    expect(isV2ResetCommand("quero dar #reset na senha")).toBe(false);
  });

  it("número fora da lista de teste (e não operador): segue como mensagem comum", async () => {
    mocks.contactFindUnique.mockResolvedValue({ phone: "5511900000000" });
    const consumed = await handleV2ResetCommand({ conversationId: "conv-1", contactId: "c1", channel: "meta" });
    expect(consumed).toBe(false);
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
  });

  it("número de teste: apaga o estado de todas as conversas do contato, confirma, marca a sessão e encerra o ticket", async () => {
    mocks.contactFindUnique.mockResolvedValue({ phone: "+55 11 91111-2222" });
    const consumed = await handleV2ResetCommand({ conversationId: "conv-1", contactId: "c1", channel: "meta", messageId: "msg-1" });
    expect(consumed).toBe(true);
    expect(mocks.invalidateOpenTurns).toHaveBeenCalledWith("conv-1", "v2_reset");
    expect(mocks.stateDeleteMany).toHaveBeenCalledWith({ where: { conversationId: { in: ["conv-1", "conv-old"] } } });
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ agentUserId: "ai-1", bypassAssigneeCheck: true }));
    expect(mocks.logV2Turn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "reset", agentId: "agent-1" }));
    expect(mocks.resolveInline).toHaveBeenCalledWith(expect.objectContaining({ ids: ["conv-1"] }));
  });

  it("com atendimento IA desligado avisa na confirmação", async () => {
    mocks.contactFindUnique.mockResolvedValue({ phone: "5511911112222" });
    mocks.attendance.mockResolvedValue(false);
    await handleV2ResetCommand({ conversationId: "conv-1", contactId: "c1", channel: "meta" });
    expect(mocks.sendAgentMessage.mock.calls[0][0].text).toContain("desligado");
  });
});

describe("rastro do turno", () => {
  it("coleta passos dentro do turno e entrega ao log uma vez", async () => {
    const steps = await runWithV2Trace(async () => {
      traceStep("regra", "Nenhuma regra automática casou");
      traceStep("assunto", "Assunto X");
      return takeV2TraceForLog();
    });
    expect(steps?.map((s) => s.step)).toEqual(["regra", "assunto"]);
  });

  it("fora de um turno não quebra", () => {
    expect(() => traceStep("x", "y")).not.toThrow();
    expect(takeV2TraceForLog()).toBeUndefined();
  });
});

function logRow(over: Record<string, unknown>) {
  return {
    id: "l1",
    createdAt: new Date("2026-01-01T10:00:00Z"),
    conversationId: "conv-1",
    inboundText: "oi",
    prompt: "",
    reply: "olá",
    handoff: false,
    error: null,
    llmOutput: { reason: "saudação" },
    discardedActions: [],
    contextSnapshot: { stage: "active", trace: [{ step: "regra", detail: "Nenhuma regra", at: 1 }] },
    latencyMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    feedback: null,
    ...over,
  };
}

describe("conversas de teste", () => {
  beforeEach(() => vi.clearAllMocks());

  it("só números de teste; #reset abre sessão nova; sessões mais recentes primeiro", async () => {
    mocks.agentFindFirst.mockResolvedValue({ simpleConfig: TEST_AGENT.simpleConfig, draftConfig: null });
    mocks.logFindMany
      .mockResolvedValueOnce([{ conversationId: "conv-1" }, { conversationId: "conv-x" }])
      .mockResolvedValueOnce([
        logRow({ id: "a", createdAt: new Date("2026-01-01T10:00:00Z") }),
        logRow({ id: "r", prompt: "reset", inboundText: "#reset", createdAt: new Date("2026-01-01T11:00:00Z") }),
        logRow({ id: "b", createdAt: new Date("2026-01-01T11:01:00Z") }),
      ]);
    mocks.conversationFindMany.mockResolvedValue([
      { id: "conv-1", contact: { id: "c1", name: "Teste", phone: "5511911112222" } },
      { id: "conv-x", contact: { id: "c9", name: "Cliente real", phone: "5511988887777" } },
    ]);

    const r = await listV2TestConversations({ organizationId: "org-1", agentId: "agent-1" });

    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].sessions.map((s) => s.turns.map((t) => t.id))).toEqual([["r", "b"], ["a"]]);
    expect(r.contacts[0].sessions[1].turns[0]).toMatchObject({ llmReason: "saudação", trace: [{ step: "regra" }] });
  });

  it("sem números de teste configurados não lista nada", async () => {
    mocks.agentFindFirst.mockResolvedValue({ simpleConfig: { name: "A", tone: "Objetivo" }, draftConfig: null });
    const r = await listV2TestConversations({ organizationId: "org-1", agentId: "agent-1" });
    expect(r).toEqual({ testNumbers: [], contacts: [] });
    expect(mocks.logFindMany).not.toHaveBeenCalled();
  });
});

describe("diagnóstico de erro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFindFirst.mockResolvedValue({ ...logRow({}), organizationId: "org-1", agentId: "agent-1" });
    mocks.logFindMany.mockResolvedValue([]);
    mocks.agentFindFirst.mockResolvedValue({ simpleConfig: { name: "A", tone: "Objetivo", model: "gpt-4o-mini" } });
    mocks.docFindMany.mockResolvedValue([{ id: "d1", title: "Como emitir comprovante" }]);
    mocks.logUpdate.mockResolvedValue({});
  });

  it("devolve e grava causa, categoria e correções", async () => {
    mocks.generate.mockResolvedValue({
      text: '```json\n{"resumo":"Transferiu sem motivo","causa":"Regra casou","categoria":"configuracao","correcoes":[{"onde":"Regras automáticas","oque":"Remover palavra genérica"}],"pedidoParaDev":null,"confianca":"alta"}\n```',
    });

    const fb = await diagnoseV2Turn({ organizationId: "org-1", agentId: "agent-1", logId: "l1", comment: "não era para transferir", userId: "u1" });

    expect(fb.diagnosis).toMatchObject({ categoria: "configuracao", correcoes: [{ onde: "Regras automáticas" }] });
    expect(mocks.logUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "l1" }, data: { feedback: fb } }));
    const sentPayload = JSON.parse(mocks.generate.mock.calls[0][0].messages[0].content);
    expect(sentPayload.comentarioDeQuemTestou).toBe("não era para transferir");
    expect(sentPayload.turnoMarcado.rastro).toEqual([{ step: "regra", detail: "Nenhuma regra", at: 1 }]);
    expect(sentPayload.materiaisExistentes).toEqual(["Como emitir comprovante"]);
  });

  it("falha do modelo grava o comentário com o erro (não perde o feedback)", async () => {
    mocks.generate.mockRejectedValue(new Error("rate limited"));
    const fb = await diagnoseV2Turn({ organizationId: "org-1", agentId: "agent-1", logId: "l1", comment: "errou", userId: null });
    expect(fb.diagnosis).toBeNull();
    expect(fb.diagnosisError).toContain("rate limited");
    expect(mocks.logUpdate).toHaveBeenCalled();
  });
});
