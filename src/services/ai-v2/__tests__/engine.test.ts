import { beforeEach, describe, expect, it, vi } from "vitest";

import type { V2AgentConfig, V2LLMOutput } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  prismaAIAgentFindUnique: vi.fn(),
  prismaConversationFindUnique: vi.fn(),
  resolveAgent: vi.fn(),
  loadContext: vi.fn(),
  sendText: vi.fn(),
  executeActions: vi.fn(),
  simpleHandoff: vi.fn(),
  getState: vi.fn(),
  upsertState: vi.fn(),
  logTurn: vi.fn(),
  callLLM: vi.fn(),
  loadBridge: vi.fn(),
  mapBridgeVars: vi.fn(),
  createDeal: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findUnique: mocks.prismaAIAgentFindUnique },
    conversation: { findUnique: mocks.prismaConversationFindUnique },
  },
}));

vi.mock("../agent-resolver", () => ({
  resolveV2AgentForConversation: mocks.resolveAgent,
  isSimpleEngineConversation: vi.fn().mockReturnValue(true),
}));

vi.mock("../context", () => ({
  loadV2Context: mocks.loadContext,
}));

vi.mock("../actions", () => ({
  sendV2TextMessage: mocks.sendText,
  executeV2Actions: mocks.executeActions,
}));

vi.mock("../handoff", () => ({
  simpleHandoff: mocks.simpleHandoff,
}));

vi.mock("../state", () => ({
  getV2ConversationState: mocks.getState,
  upsertV2ConversationState: mocks.upsertState,
  resetV2Counters: vi.fn(),
}));

vi.mock("../log", () => ({
  logV2Turn: mocks.logTurn,
}));

vi.mock("../llm", () => ({
  callV2LLM: mocks.callLLM,
  callV2LLMTest: vi.fn(),
}));

vi.mock("../automation-bridge", () => ({
  loadV2AutomationBridge: mocks.loadBridge,
  mapAutomationVariables: mocks.mapBridgeVars,
  continueV2AutomationOnClose: vi.fn(),
}));

vi.mock("@/services/deals", () => ({
  createDeal: mocks.createDeal,
}));

function baseConfig(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
  return {
    name: "Agente de teste",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: ["Não prometa retornar depois."],
    allowedDomains: [],
    contextFields: { contact: [], deal: [] },
    variables: [],
    entry: { confirmContact: true, onDealNotFound: "ask_identification" },
    handoff: {
      defaultDestination: { type: "department" },
      message: "Vou transferir.",
      humanRequestKeywords: ["humano"],
    },
    closure: {},
    limits: {},
    media: {},
    sentiment: {},
    survey: {},
    themes: [],
    rules: [],
    autonomyMode: "autonomous",
    ...overrides,
  } as unknown as V2AgentConfig;
}

function makeState(stage: string, owner = "agente") {
  return {
    id: "state-1",
    conversationId: "conv-1",
    agentId: "agent-1",
    stage,
    owner,
    themeId: null,
    counters: {},
    versionId: null,
    postCloseWindowEndAt: null,
    closeReason: null,
  } as any;
}

describe("processV2Turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgent.mockResolvedValue({
      userId: "user-1",
      agentConfigId: "agent-1",
      wasAssigned: true,
    });
    mocks.prismaConversationFindUnique.mockResolvedValue({ contactId: "contact-1" });
    mocks.loadBridge.mockResolvedValue({ variables: {} });
    mocks.mapBridgeVars.mockReturnValue({});
    mocks.getState.mockResolvedValue(null);
    mocks.executeActions.mockResolvedValue({ results: [], anyHandoff: false, anyClose: false });
    mocks.sendText.mockResolvedValue(undefined);
    mocks.simpleHandoff.mockResolvedValue(undefined);
    mocks.upsertState.mockResolvedValue(undefined);
    mocks.logTurn.mockResolvedValue(undefined);
  });

  it("primeira mensagem sem deal e onDealNotFound=handoff => handoff", async () => {
    const config = baseConfig({ entry: { confirmContact: false, onDealNotFound: "handoff" } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      deals: [],
      selectedDeal: null,
      dealId: undefined,
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(result.handoff).toBe(true);
    expect(mocks.sendText).toHaveBeenCalled();
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("primeira mensagem com deal => envia confirmação e fica em confirming", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      deals: [{ id: "deal-1" }],
      selectedDeal: { id: "deal-1" },
      dealId: "deal-1",
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(result.handoff).toBe(false);
    expect(result.closed).toBe(false);
    const sent = mocks.sendText.mock.calls.find((c) => c[0].text)?.[0].text ?? "";
    expect(sent.length).toBeGreaterThan(0);
    const upsert = mocks.upsertState.mock.calls.find((c) => c[0].stage === "confirming");
    expect(upsert).toBeTruthy();
  });

  it("confirmação negativa => pergunta identificação e vai para identifying", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      deals: [{ id: "deal-1" }],
      selectedDeal: { id: "deal-1" },
      dealId: "deal-1",
    });
    mocks.getState.mockResolvedValue(makeState("confirming"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "",
        confirmed: false,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Não confirmou",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Não sou João",
    });

    expect(result.handoff).toBe(false);
    expect(result.closed).toBe(false);
    expect(mocks.callLLM).toHaveBeenCalled();
    const upsert = mocks.upsertState.mock.calls.find((c) => c[0].stage === "identifying");
    expect(upsert).toBeTruthy();
  });

  it("LLM pede handoff => transfere e muda dono para pessoa", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      deals: [{ id: "deal-1" }],
      selectedDeal: { id: "deal-1" },
      dealId: "deal-1",
    });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Vou transferir.",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Pedido humano",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Quero falar com humano",
    });

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalled();
    const upsert = mocks.upsertState.mock.calls.find((c) => c[0].owner === "pessoa");
    expect(upsert).toBeTruthy();
  });
});
