import { beforeEach, describe, expect, it, vi } from "vitest";

import type { V2AgentConfig, V2LLMOutput } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  prismaAIAgentFindUnique: vi.fn(),
  prismaConversationFindUnique: vi.fn(),
  resolveAgent: vi.fn(),
  loadContext: vi.fn(),
  sendText: vi.fn(),
  writeSummary: vi.fn(),
  appliedRules: vi.fn(),
  loadPriorSummary: vi.fn(),
  updateRunningSummary: vi.fn(),
  executeActions: vi.fn(),
  simpleHandoff: vi.fn(),
  getState: vi.fn(),
  upsertState: vi.fn(),
  logTurn: vi.fn(),
  callLLM: vi.fn(),
  loadBridge: vi.fn(),
  mapBridgeVars: vi.fn(),
  createDeal: vi.fn(),
  attendanceEnabled: vi.fn(),
  messageFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  findInherited: vi.fn(),
  resolveInline: vi.fn(),
  distributeNewInbound: vi.fn(),
  recentlySent: vi.fn(async (): Promise<Set<string>> => new Set()),
  pendingFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  messageFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  conversationUpdateMany: vi.fn(async () => ({ count: 1 })),
  turnFindUnique: vi.fn(async (): Promise<{ status: string; claimedAt: Date | null } | null> => null),
}));

vi.mock("../sent-materials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sent-materials")>()),
  recentlySentMessageModels: mocks.recentlySent,
  recentlyAppliedRuleIds: mocks.appliedRules,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findUnique: mocks.prismaAIAgentFindUnique },
    conversation: { findUnique: mocks.prismaConversationFindUnique, updateMany: mocks.conversationUpdateMany },
    distributionPending: { findFirst: mocks.pendingFindFirst },
    message: { findMany: mocks.messageFindMany, findFirst: mocks.messageFindFirst },
    messageTemplate: { findMany: mocks.templateFindMany },
    conversationTurn: { findUnique: mocks.turnFindUnique },
  },
}));

vi.mock("../agent-resolver", () => ({
  resolveV2AgentForConversation: mocks.resolveAgent,
  isSimpleEngineConversation: vi.fn().mockReturnValue(true),
}));

vi.mock("../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context")>();
  return {
    ...actual,
    loadV2Context: mocks.loadContext,
  };
});

vi.mock("../actions", () => ({
  sendV2TextMessage: mocks.sendText,
  executeV2Actions: mocks.executeActions,
  v2HumanBehavior: (config: { simulateTyping?: boolean; typingPerCharMs?: number; markMessagesRead?: boolean } = {}) => ({
    simulateTyping: config.simulateTyping !== false,
    typingPerCharMs: typeof config.typingPerCharMs === "number" && config.typingPerCharMs >= 0 ? config.typingPerCharMs : 25,
    markMessagesRead: config.markMessagesRead !== false,
  }),
}));

vi.mock("../summary", () => ({
  writeV2Summary: mocks.writeSummary,
  loadPriorV2Summary: mocks.loadPriorSummary,
  SUMMARY_MESSAGE_TYPE: "ai_summary",
  updateRunningSummary: mocks.updateRunningSummary,
  summaryEnabled: (config: { closure?: { summary?: { enabled?: boolean } } }) =>
    config.closure?.summary?.enabled ? config.closure.summary : null,
}));

vi.mock("../handoff", () => ({
  simpleHandoff: mocks.simpleHandoff,
}));

vi.mock("../state", () => ({
  getV2ConversationState: mocks.getState,
  upsertV2ConversationState: mocks.upsertState,
  findInheritablePostCloseState: mocks.findInherited,
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

vi.mock("@/services/ai/attendance-gate", () => ({
  isAiAttendanceEnabled: mocks.attendanceEnabled,
}));

vi.mock("../ensure-schema", () => ({
  ensureV2AgentSchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/org-settings", () => ({
  getOrgSetting: vi.fn(async () => null),
  getOrgSettingBool: vi.fn(async (_k: string, d: boolean) => d),
}));

vi.mock("@/services/conversations", () => ({
  resolveConversationsInline: mocks.resolveInline,
}));

vi.mock("@/services/distribution", () => ({
  maybeDistributeNewInboundTicket: mocks.distributeNewInbound,
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
    autonomyMode: "auto",
    ...overrides,
  } as unknown as V2AgentConfig;
}

function makeState(stage: string, owner = "agente", counters: Record<string, unknown> = {}) {
  return {
    id: "state-1",
    conversationId: "conv-1",
    agentId: "agent-1",
    stage,
    owner,
    themeId: null,
    counters,
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
    mocks.sendText.mockResolvedValue({ sent: true });
    mocks.simpleHandoff.mockResolvedValue(undefined);
    mocks.upsertState.mockResolvedValue(undefined);
    mocks.logTurn.mockResolvedValue(undefined);
    mocks.attendanceEnabled.mockResolvedValue(true);
    mocks.findInherited.mockResolvedValue(null);
    mocks.writeSummary.mockResolvedValue(null);
    mocks.loadPriorSummary.mockResolvedValue(null);
    mocks.appliedRules.mockResolvedValue(new Set());
    mocks.updateRunningSummary.mockResolvedValue(null);
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.resolveInline.mockResolvedValue({ updated: 1, missing: 0 });
    mocks.distributeNewInbound.mockResolvedValue(undefined);
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

  it("confirmationMode separate_turn => envia só boas-vindas no 1º turno e marca entryConfirmationPending", async () => {
    const config = baseConfig({
      entry: {
        confirmContact: true,
        onDealNotFound: "ask_identification",
        confirmationMode: "separate_turn",
        openingEnabled: true,
        openingMessage: "Oi, @name! Sou a assistente virtual da Empresa Exemplo.",
        confirmationMessage: "Confirmo que estou falando com você. Como posso ajudar?",
      } as any,
    });
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
    expect(sent).toContain("Oi, João!");
    expect(sent).not.toContain("Confirmo");
    const upsert = mocks.upsertState.mock.calls.find((c) => c[0].stage === "confirming");
    expect(upsert?.[0].entryConfirmationPending).toBe(true);
  });

  it("confirmationMode separate_turn => envia confirmação no 2º turno e limpa pending", async () => {
    const config = baseConfig({
      entry: {
        confirmContact: true,
        onDealNotFound: "ask_identification",
        confirmationMode: "separate_turn",
        openingEnabled: true,
        openingMessage: "Oi, {{contact.name}}!",
        confirmationMessage: "Confirmo que estou falando com você, {{contact.name}}. Como posso ajudar?",
      } as any,
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      deals: [{ id: "deal-1" }],
      selectedDeal: { id: "deal-1" },
      dealId: "deal-1",
    });
    mocks.getState.mockResolvedValue({
      ...makeState("confirming"),
      entryConfirmationPending: true,
    });
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Tudo bem, João! No que posso ajudar?",
        confirmed: true,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Confirmou identidade",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [],
      governorStats: { totalCalls: 1, replays: 0, denials: 0, limitHit: false },
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "sim sou eu",
    });

    expect(result.handoff).toBe(false);
    expect(result.closed).toBe(false);
    const confirmationCall = mocks.sendText.mock.calls.find((c) =>
      (c[0].text as string).includes("Confirmo"),
    );
    expect(confirmationCall).toBeTruthy();
    const upsert = mocks.upsertState.mock.calls.find((c) => c[0].stage === "confirming");
    expect(upsert?.[0].entryConfirmationPending).toBe(false);
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

  it("ações de efeito fora da allowlist do tema são descartadas pelo executor", async () => {
    const config = baseConfig({
      themes: [
        {
          id: "vendas",
          name: "Vendas",
          instructions: "venda",
          when: ["produto"],
          examples: [],
          allowedTools: ["add_tag"],
          allowedKnowledgeDocIds: [],
          allowedMessageModelIds: [],
          knowledgeDocIds: [],
          messageModelIds: [],
          productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
        } as any,
      ],
    });
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
        reply: "Vou enviar.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Produto",
        actions: [
          { type: "add_tag", tag: "interesse" },
          { type: "send_product", productId: "p1" },
        ],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [],
      governorStats: { totalCalls: 0, replays: 0, denials: 0, limitHit: false },
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Quero produto",
    });

    const passedActions = mocks.executeActions.mock.calls[0][0];
    expect(passedActions.map((a: any) => a.type)).toEqual(["add_tag"]);
    const logCall = mocks.logTurn.mock.calls.find((c) => c[0].reply);
    expect(logCall?.[0].discardedActions.map((a: any) => a.type)).toContain("send_product");
  });

  it("consulta vazia e sem dados do cliente força handoff com a mensagem configurada", async () => {
    const config = baseConfig({
      themes: [
        {
          id: "suporte",
          name: "Suporte",
          instructions: "suporte",
          when: [],
          examples: [],
          allowedTools: ["knowledge_search"],
          allowedKnowledgeDocIds: [],
          allowedMessageModelIds: [],
          knowledgeDocIds: [],
          messageModelIds: [],
          productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
        } as any,
      ],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({ contact: null, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Aqui está a resposta.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Tentativa",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [{ toolName: "knowledge_search", args: { query: "x" }, result: { chunks: [] } }],
      governorStats: { totalCalls: 1, replays: 0, denials: 0, limitHit: false },
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Como funciona x?",
    });

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalled();
    const sent = mocks.sendText.mock.calls.find((c) => c[0].text)?.[0].text ?? "";
    expect(sent).toBe(config.handoff.message);
  });

  it("consulta vazia e sem dados do cliente aplica mensagem de 'sem material' configurada", async () => {
    const config = baseConfig({
      fallback: { noSource: { message: "Não encontrei isso nos materiais; vou transferir para um consultor." } } as any,
      themes: [
        {
          id: "suporte",
          name: "Suporte",
          instructions: "suporte",
          when: [],
          examples: [],
          allowedTools: ["knowledge_search"],
          allowedKnowledgeDocIds: [],
          allowedMessageModelIds: [],
          knowledgeDocIds: [],
          messageModelIds: [],
          productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
        } as any,
      ],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({ contact: null, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Aqui está a resposta.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Tentativa",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [{ toolName: "knowledge_search", args: { query: "x" }, result: { chunks: [] } }],
      governorStats: { totalCalls: 1, replays: 0, denials: 0, limitHit: false },
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Como funciona x?",
    });

    expect(result.handoff).toBe(false);
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
    const sent = mocks.sendText.mock.calls.find((c) => c[0].text)?.[0].text ?? "";
    expect(sent).toBe("Não encontrei isso nos materiais; vou transferir para um consultor.");
  });

  it("regra contact_tag dispara ação terminal sem chamar LLM", async () => {
    const config = baseConfig({
      rules: [
        {
          id: "tag-vip",
          name: "VIP",
          order: 1,
          conditions: [{ type: "contact_tag", values: ["VIP"] }],
          actions: [{ type: "send_message", message: "Atendimento VIP." }],
        } as any,
      ],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    // Como o loadV2Context real devolve: `contact` indexado pelo rótulo dos
    // campos configurados (sem tags); as tags ficam no `contactRaw`.
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { name: "João", tags: ["VIP"] }, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => ({
      results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false,
    }));

    const { processV2Turn } = await import("../engine");
    await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("ação terminal da regra que falha (sem parâmetro) segue para o agente", async () => {
    const config = baseConfig({
      rules: [{ id: "r1", name: "Sem texto", order: 1, conditions: [{ type: "contact_tag", values: ["VIP"] }], actions: [{ type: "send_message" }] } as any],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { name: "João", tags: ["VIP"] }, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => ({
      results: actions.map((a) => ({ action: a, ok: false, error: "Missing message" })), anyHandoff: false, anyClose: false,
    }));
    mocks.callLLM.mockResolvedValue(llmOut());

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Oi" });

    expect(mocks.callLLM).toHaveBeenCalled();
  });

  it("regra desligada não é avaliada", async () => {
    const config = baseConfig({
      rules: [{ id: "r1", name: "Off", order: 1, enabled: false, conditions: [{ type: "contact_tag", values: ["VIP"] }], actions: [{ type: "send_message", message: "x" }] } as any],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { name: "João", tags: ["VIP"] }, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue(llmOut());

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Oi" });

    expect(mocks.callLLM).toHaveBeenCalled();
  });

  it("excedido limite de transferências IA força handoff para destino padrão", async () => {
    const config = baseConfig({
      limits: { maxAiTransfers: 1 } as any,
      handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["humano"] },
      themes: [
        {
          id: "vendas",
          name: "Vendas",
          instructions: "venda",
          when: [],
          examples: [],
          allowedTools: ["handoff"],
          allowedKnowledgeDocIds: [],
          allowedMessageModelIds: [],
          knowledgeDocIds: [],
          messageModelIds: [],
          productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
        } as any,
      ],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      deals: [{ id: "deal-1" }],
      selectedDeal: { id: "deal-1" },
      dealId: "deal-1",
    });
    mocks.getState.mockResolvedValue(makeState("active", "agente", { aiTransferCount: 1 }));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Vou passar.",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Para IA",
        actions: [{ type: "handoff", destination: { type: "ai_agent", id: "agent-2" } }],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Quero falar com outro bot",
    });

    expect(mocks.simpleHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ destination: { type: "department" } }),
    );
  });

  it("transferência transparente: o agente que recebe é instruído a não se apresentar; o padrão não", async () => {
    const transparent = baseConfig({ entry: { ...baseConfig().entry, onAiTransfer: "continue" } } as any);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: transparent, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "A segunda via sai pelo portal, em Pagamentos." }));

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Preciso da segunda via", messageIds: ["m-cur"] });

    expect(mocks.callLLM.mock.calls[0][0].transparentTransfer).toBe(true);

    vi.clearAllMocks();
    mocks.sendText.mockResolvedValue({ sent: true });
    mocks.upsertState.mockResolvedValue(undefined);
    mocks.logTurn.mockResolvedValue(undefined);
    mocks.loadPriorSummary.mockResolvedValue(null);
    mocks.appliedRules.mockResolvedValue(new Set());
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "A segunda via sai pelo portal, em Pagamentos." }));

    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Preciso da segunda via", messageIds: ["m-cur"] });

    expect(mocks.callLLM.mock.calls[0][0].transparentTransfer).toBe(false);
  });

  it("transferir para agente de IA transparente: sem aviso de transferência ao cliente", async () => {
    mocks.prismaAIAgentFindUnique.mockImplementation(async (args: { where?: { id?: string } }) =>
      args?.where?.id === "agent-2"
        ? { id: "agent-2", simpleConfig: { entry: { onAiTransfer: "continue" } }, active: true }
        : { id: "agent-1", simpleConfig: baseConfig(), active: true },
    );
    mocks.getState.mockResolvedValue(makeState("active", "agente"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Assunto de outro agente",
        actions: [{ type: "handoff", destination: { type: "ai_agent", id: "agent-2" } }],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Quero falar sobre o plano" });

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: expect.objectContaining({ type: "ai_agent", id: "agent-2" }) }));
    const sent = mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text).join(" ");
    expect(sent).not.toContain("Vou transferir");
  });

  it("agente que transfere em modo transparente: também sem aviso, mesmo com o destino no padrão", async () => {
    mocks.prismaAIAgentFindUnique.mockImplementation(async (args: { where?: { id?: string } }) =>
      args?.where?.id === "agent-2"
        ? { id: "agent-2", simpleConfig: { entry: { onAiTransfer: "present" } }, active: true }
        : { id: "agent-1", simpleConfig: baseConfig({ entry: { ...baseConfig().entry, onAiTransfer: "continue" } } as any), active: true },
    );
    mocks.getState.mockResolvedValue(makeState("active", "agente"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Assunto de outro agente",
        actions: [{ type: "handoff", destination: { type: "ai_agent", id: "agent-2" } }],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Quero falar sobre o plano" });

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: expect.objectContaining({ type: "ai_agent", id: "agent-2" }) }));
    const sent = mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text).join(" ");
    expect(sent).not.toContain("Vou transferir");
  });

  it("transferência em cadeia logo após receber: o aviso do agente anterior já cobriu; sem aviso anterior, avisa", async () => {
    const handoffOut = {
      reply: "",
      confirmed: null,
      handoff: true,
      concluded: false,
      outOfScope: true,
      sentiment: "neutral",
      collected: {},
      reason: "Fora do escopo deste agente",
      actions: [{ type: "handoff", destination: { type: "department" } }],
    } satisfies V2LLMOutput;
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }] : [],
    );
    // O agente anterior já mandou "vou te passar para…" depois da mensagem.
    mocks.messageFindFirst.mockResolvedValue({ id: "m-notice" });
    mocks.callLLM.mockResolvedValue({ output: handoffOut, inputTokens: 10, outputTokens: 5, latencyMs: 100 });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Quero saber os valores do plano", messageIds: ["m-cur"] });

    expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: { type: "department" } }));
    expect(mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text).join(" ")).not.toContain("Vou transferir");

    vi.clearAllMocks();
    mocks.sendText.mockResolvedValue({ sent: true });
    mocks.upsertState.mockResolvedValue(undefined);
    mocks.logTurn.mockResolvedValue(undefined);
    mocks.loadPriorSummary.mockResolvedValue(null);
    mocks.appliedRules.mockResolvedValue(new Set());
    mocks.simpleHandoff.mockResolvedValue(undefined);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }] : [],
    );
    // Anterior transparente: nada foi dito depois da mensagem → este avisa.
    mocks.messageFindFirst.mockResolvedValue(null);
    mocks.callLLM.mockResolvedValue({ output: handoffOut, inputTokens: 10, outputTokens: 5, latencyMs: 100 });

    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Quero saber os valores do plano", messageIds: ["m-cur"] });

    expect(mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text).join(" ")).toContain("Vou transferir");
  });

  it("conversa recebida de outro agente no estado inicial: sem boas-vindas nem confirmação — responde direto", async () => {
    const config = baseConfig({
      entry: { ...baseConfig().entry, openingEnabled: true, openingMessage: "Olá! Sou seu assistente virtual.", confirmContact: true, confirmationMessage: "Confirmo que estou falando com você." },
    } as any);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("idle", "pessoa"), agentId: "agent-0" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Para pausar o plano, abra Solicitações no portal e escolha Pausa." }));

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Como faço para pausar o plano?" });

    const sent = mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(sent.join(" ")).toContain("Para pausar o plano");
    expect(sent.join(" ")).not.toContain("Olá! Sou seu assistente");
    expect(sent.join(" ")).not.toContain("Confirmo que estou falando");
  });

  it("devolver a conversa para o agente que acabou de passá-la vai para o destino padrão (sem ping-pong)", async () => {
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: true,
        sentiment: "neutral",
        collected: {},
        reason: "Assunto do outro agente",
        actions: [{ type: "handoff", destination: { type: "ai_agent", id: "agent-0" } }],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Cancelei e quero ver a parte financeira" });

    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: { type: "department" } }));
    const saved = mocks.upsertState.mock.calls.map((c) => c[0] as { counters?: { receivedFromAgentId?: string } }).find((c) => c.counters?.receivedFromAgentId);
    expect(saved?.counters?.receivedFromAgentId).toBe("agent-0");
  });

  it("destino trocado (ping-pong): a mensagem do assunto não sai — sai a mensagem padrão de transferência", async () => {
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: true,
        sentiment: "neutral",
        collected: {},
        reason: "Assunto do outro agente",
        actions: [{ type: "handoff", destination: { type: "ai_agent", id: "agent-0", message: "Vou te passar para o setor X." } }],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Quero mudar de plano" });

    expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: { type: "department" } }));
    const sent = mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text).join(" | ");
    expect(sent).not.toContain("setor X");
    expect(sent).toContain("Vou transferir.");
  });

  it("destino de transferência igual ao próprio agente vai para o destino padrão, não para si mesmo", async () => {
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
    mocks.getState.mockResolvedValue(makeState("active", "agente"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Vou chamar o time para te ajudar com esse acesso.",
        confirmed: null,
        handoff: true,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Falha persiste",
        actions: [{ type: "handoff", destination: { type: "ai_agent", id: "agent-1" } }],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage: "Fica a tela branca, já tentei quatro vezes" });

    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: { type: "department" } }));
    expect(mocks.simpleHandoff).not.toHaveBeenCalledWith(expect.objectContaining({ destination: expect.objectContaining({ type: "ai_agent", id: "agent-1" }) }));
  });

  it("governor limit hit sem resultados e sem dados do cliente força handoff", async () => {
    const config = baseConfig({
      themes: [
        {
          id: "suporte",
          name: "Suporte",
          instructions: "suporte",
          when: [],
          examples: [],
          allowedTools: ["knowledge_search"],
          allowedKnowledgeDocIds: [],
          allowedMessageModelIds: [],
          knowledgeDocIds: [],
          messageModelIds: [],
          productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
        } as any,
      ],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({ contact: null, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Resposta da memória",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Tentativa",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [{ toolName: "knowledge_search", args: { query: "x" }, result: { chunks: [] } }],
      governorStats: { totalCalls: 5, replays: 0, denials: 0, limitHit: true },
    });

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Como funciona x?",
    });

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalled();
    const sent = mocks.sendText.mock.calls.find((c) => c[0].text)?.[0].text ?? "";
    expect(sent).toBe(config.handoff.message);
  });

  it("send_message vindo de regra respeita limite de parada (loop) e não chama LLM", async () => {
    const config = baseConfig({
      limits: { maxLoopCount: 3, nonsenseAction: "warn_and_silence" } as any,
      rules: [
        {
          id: "vip",
          name: "VIP",
          order: 1,
          conditions: [{ type: "contact_tag", values: ["VIP"] }],
          actions: [{ type: "send_message", message: "Atendimento VIP." }],
        } as any,
      ],
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { name: "João", tags: ["VIP"] }, deals: [], selectedDeal: null, dealId: undefined });
    // Cliente mandou "oi" pela 3ª vez seguida.
    mocks.getState.mockResolvedValue(makeState("active", "agente", { loopCount: 2, lastLoopMessage: "oi" }));

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(result.handoff).toBe(false);
    expect(result.closed).toBe(false);
  });

  it("agente desativado não responde no canal real (parte C, item 3)", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: false });
    mocks.loadContext.mockResolvedValue({ contact: { name: "João" }, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(result.error).toBe("Agent inactive");
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("allowedPhoneNumbers preenchida ignora números fora da lista (parte C, item 1)", async () => {
    const config = baseConfig({ allowedPhoneNumbers: ["11999999999"] });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.prismaConversationFindUnique.mockResolvedValue({ contactId: "contact-1" });
    mocks.loadContext.mockResolvedValue({ contact: { phone: "11888888888" }, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue(makeState("active"));

    const { processV2Turn } = await import("../engine");
    const result = await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(result.error).toBe("Phone number not in allowed test list");
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("modo sugestão envia mensagem como DRAFT, não autônomo (parte C, item 4)", async () => {
    const config = baseConfig({ autonomyMode: "suggest" });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockResolvedValue({
      contact: { name: "João" },
      citableContact: { name: "João" },
      deals: [{ id: "deal-1" }],
      selectedDeal: { id: "deal-1" },
      citableDeal: { id: "deal-1" },
      dealId: "deal-1",
    });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Oi, João!",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Saudação",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    const sent = mocks.sendText.mock.calls.find((c) => c[0].text)?.[0];
    expect(sent?.text).toBe("Oi, João!");
    expect(sent?.autonomyMode).toBe("DRAFT");
  });

  it("salva negócio escolhido pelo cliente e continua sem perguntar de novo (modo 'ask')", async () => {
    const config = baseConfig({
      dealSelection: "ask",
      contextFields: {
        contact: [],
        deal: [{ key: "title", label: "Nome", permissions: ["cite"] }],
      },
    });
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config });
    mocks.loadContext.mockImplementation((args: { selectedDealId?: string }) => {
      const deals = [
        { id: "deal-a", title: "Plano A" },
        { id: "deal-b", title: "Plano B" },
      ];
      if (args.selectedDealId === "deal-b") {
        return Promise.resolve({
          contact: null,
          citableContact: null,
          deals,
          selectedDeal: { id: "deal-b", title: "Plano B" },
          citableDeal: { id: "deal-b", title: "Plano B" },
          dealId: "deal-b",
        });
      }
      return Promise.resolve({
        contact: null,
        citableContact: null,
        deals,
        selectedDeal: null,
        citableDeal: null,
        dealId: undefined,
      });
    });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue({
      output: {
        reply: "Entendi, vamos falar do Plano B.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Escolha de negócio",
        actions: [],
      } satisfies V2LLMOutput,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
    });

    const { processV2Turn } = await import("../engine");
    await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "2",
    });

    expect(mocks.upsertState).toHaveBeenCalledWith(expect.objectContaining({ selectedDealId: "deal-b" }));
    const askCall = mocks.sendText.mock.calls.find((c: any) => c[0].text?.includes("Você tem mais de um negócio"));
    expect(askCall).toBeUndefined();
    expect(mocks.callLLM).toHaveBeenCalled();
  });
});

function llmOut(overrides: Partial<V2LLMOutput> = {}): { output: V2LLMOutput; inputTokens: number; outputTokens: number; latencyMs: number } {
  return {
    output: {
      reply: "Resposta do agente.",
      confirmed: null,
      handoff: false,
      concluded: false,
      outOfScope: false,
      sentiment: "neutral",
      collected: {},
      reason: "",
      actions: [],
      ...overrides,
    } as V2LLMOutput,
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 100,
  };
}

const CONTEXT_WITH_DEAL = {
  contact: { Nome: "João" },
  contactRaw: { id: "contact-1", name: "João" },
  deals: [{ id: "deal-1" }],
  selectedDeal: { Negócio: "Contrato" },
  selectedDealRaw: { id: "deal-1", title: "Contrato" },
  dealId: "deal-1",
};

describe("processV2Turn — correções do motor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgent.mockResolvedValue({ userId: "user-1", agentConfigId: "agent-1", wasAssigned: false });
    mocks.prismaConversationFindUnique.mockResolvedValue({ contactId: "contact-1", organizationId: "org-1", contact: { phone: "5511999999999" } });
    mocks.loadBridge.mockResolvedValue({ variables: {} });
    mocks.mapBridgeVars.mockReturnValue({});
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.executeActions.mockResolvedValue({ results: [], anyHandoff: false, anyClose: false });
    mocks.sendText.mockResolvedValue({ sent: true });
    mocks.simpleHandoff.mockResolvedValue(undefined);
    mocks.upsertState.mockResolvedValue(undefined);
    mocks.logTurn.mockResolvedValue(undefined);
    mocks.attendanceEnabled.mockResolvedValue(true);
    mocks.findInherited.mockResolvedValue(null);
    mocks.writeSummary.mockResolvedValue(null);
    mocks.loadPriorSummary.mockResolvedValue(null);
    mocks.appliedRules.mockResolvedValue(new Set());
    mocks.updateRunningSummary.mockResolvedValue(null);
    mocks.resolveInline.mockResolvedValue({ updated: 1, missing: 0 });
    mocks.distributeNewInbound.mockResolvedValue(undefined);
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.loadContext.mockResolvedValue(CONTEXT_WITH_DEAL);
  });

  async function run(userMessage: string, extra: Record<string, unknown> = {}) {
    const { processV2Turn } = await import("../engine");
    return processV2Turn({ conversationId: "conv-1", channel: "meta", userMessage, ...extra });
  }

  it("rastro: o log do turno recebe os passos de decisão", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reason: "Cliente pediu informação" }));
    const { takeV2TraceForLog } = await import("../trace");
    let trace: Array<{ step: string; detail: string }> | undefined;
    mocks.logTurn.mockImplementation(async () => {
      trace = takeV2TraceForLog();
    });

    await run("Preciso de uma informação sobre o serviço");

    const steps = trace?.map((t) => t.step) ?? [];
    expect(steps).toEqual(expect.arrayContaining(["entrada", "agente", "estado", "regra", "assunto", "llm"]));
    expect(trace?.find((t) => t.step === "llm")?.detail).toContain("Cliente pediu informação");
  });

  it("rastro mostra o que o modelo buscou e o que achou", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue({
      ...llmOut(),
      toolCalls: [
        { toolName: "knowledge_search", args: { query: "x", prefetch: true }, result: { chunks: [{ docTitle: "Pré" }] } },
        { toolName: "knowledge_search", args: { query: "como emitir comprovante" }, result: { chunks: [{ docTitle: "Emitir comprovante" }, { docTitle: "Emitir comprovante" }] } },
        { toolName: "knowledge_search", args: { query: "segunda via" }, result: { chunks: [] } },
      ],
    });
    const { takeV2TraceForLog } = await import("../trace");
    let trace: Array<{ step: string; detail: string }> | undefined;
    mocks.logTurn.mockImplementation(async () => {
      trace = takeV2TraceForLog();
    });

    await run("Preciso emitir um comprovante do meu cadastro");

    const tools = trace?.filter((t) => t.step === "ferramenta").map((t) => t.detail);
    expect(tools).toEqual([
      'knowledge_search "como emitir comprovante" → Emitir comprovante',
      'knowledge_search "segunda via" → nada encontrado',
    ]);
  });

  it("handoff pedido como AÇÃO: avisa o cliente antes e transfere uma vez só", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ actions: [{ type: "handoff" }] as any }));
    const order: string[] = [];
    mocks.sendText.mockImplementation(async () => { order.push("send"); return { sent: true }; });
    mocks.simpleHandoff.mockImplementation(async () => { order.push("handoff"); });

    const result = await run("Quero falar com alguém");

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["send", "handoff"]);
    expect(mocks.sendText.mock.calls[0][0].text).toBe("Vou transferir.");
    // O executor genérico não recebe o handoff (não transfere por conta própria).
    const executed = mocks.executeActions.mock.calls.flatMap((c) => c[0] as Array<{ type: string }>);
    expect(executed.some((a) => a.type === "handoff")).toBe(false);
  });

  it("destino pedido na ação de handoff é respeitado", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ actions: [{ type: "handoff", destination: { type: "user", id: "u-9" } }] as any }));

    await run("Me passa pro financeiro");

    expect(mocks.simpleHandoff.mock.calls[0][0].destination).toEqual({ type: "user", id: "u-9" });
  });

  it("promessa de retorno na resposta vira handoff de verdade", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Vou verificar e te retorno em breve." }));

    const result = await run("Meu boleto venceu");

    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
  });

  it("identificação: resposta com e-mail/documento transfere (a equipe localiza o cadastro)", async () => {
    const config = baseConfig({ entry: { confirmContact: false, onDealNotFound: "ask_identification", maxAttempts: 3 } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { id: "contact-1" }, deals: [], selectedDeal: null, dealId: undefined });
    mocks.getState.mockResolvedValue({ ...makeState("identifying"), identificationAttempts: 1 });
    const result = await run("meu documento é 123.456.789-00");
    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).not.toContain("localizei");

    const { looksLikeIdentification } = await import("../engine");
    for (const m of ["ana@exemplo.com", "123.456.789-00", "meu código é 98765"]) expect(looksLikeIdentification(m)).toBe(true);
    for (const m of ["como assim?", "não sei", "oi", "dia 12"]) expect(looksLikeIdentification(m)).toBe(false);
  });

  it("identificação: 2ª tentativa com outro texto e depois transfere", async () => {
    const config = baseConfig({ entry: { confirmContact: false, onDealNotFound: "ask_identification", maxAttempts: 2 } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { id: "contact-1" }, deals: [], selectedDeal: null, dealId: undefined });

    // 1º turno: pergunta.
    mocks.getState.mockResolvedValue(null);
    await run("Oi");
    const first = mocks.sendText.mock.calls.at(-1)![0].text as string;
    expect(mocks.upsertState.mock.calls.at(-1)![0]).toMatchObject({ stage: "identifying", identificationAttempts: 1 });

    // 2º turno: resposta sem e-mail nem documento → pede de novo, com outro texto.
    mocks.getState.mockResolvedValue({ ...makeState("identifying"), identificationAttempts: 1 });
    await run("como assim?");
    const second = mocks.sendText.mock.calls.at(-1)![0].text as string;
    expect(second).not.toBe(first);
    expect(mocks.upsertState.mock.calls.at(-1)![0]).toMatchObject({ stage: "identifying", identificationAttempts: 2 });

    // 3º turno: esgotou → transfere, sem chamar o LLM.
    mocks.getState.mockResolvedValue({ ...makeState("identifying"), identificationAttempts: 2 });
    const result = await run("não sei");
    expect(result.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("pós-encerramento no_reply (padrão para cortesia): não responde, salva contador e reencerra o ticket", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({
      ...makeState("closed", "ninguem"),
      postCloseWindowEndAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await run("Obrigado!");

    expect(result.closed).toBe(true);
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.upsertState.mock.calls.some((c) => c[0].counters?.courtesyReplies === 1)).toBe(true);
    expect(mocks.resolveInline).toHaveBeenCalledWith(expect.objectContaining({ ids: ["conv-1"], keepAgent: true }));
  });

  it("ticket novo aberto pelo 'obrigado' herda a janela pós-encerramento do anterior", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const windowEnd = new Date(Date.now() + 60 * 60 * 1000);
    mocks.getState.mockResolvedValue(null);
    mocks.findInherited.mockResolvedValue({ ...makeState("closed", "ninguem"), conversationId: "conv-old", postCloseWindowEndAt: windowEnd });
    mocks.upsertState.mockImplementation(async (args: any) => ({ ...makeState(args.stage ?? "closed", args.owner ?? "ninguem"), postCloseWindowEndAt: args.postCloseWindowEndAt ?? null }));

    const result = await run("valeu");

    expect(mocks.upsertState.mock.calls[0][0]).toMatchObject({ conversationId: "conv-1", stage: "closed", postCloseWindowEndAt: windowEnd });
    expect(result.closed).toBe(true);
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("memória: variáveis salvas voltam no prompt e o que o LLM coleta é persistido", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active"), collectedVariables: { plano: "Básico" } });
    mocks.callLLM.mockResolvedValue(llmOut({ collected: { turno: "noite" } }));

    await run("Prefiro à noite");

    expect(mocks.callLLM.mock.calls[0][0].collectedVariables).toMatchObject({ plano: "Básico" });
    const last = mocks.upsertState.mock.calls.at(-1)![0];
    expect(last.collectedVariables).toMatchObject({ plano: "Básico", turno: "noite" });
  });

  it("atendimento IA desligado na org: não responde e manda para a distribuição", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.attendanceEnabled.mockResolvedValue(false);

    const result = await run("Oi");

    expect(result.error).toBe("AI attendance disabled");
    expect(mocks.distributeNewInbound).toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it("resposta longa + mensagem pronta: se a mensagem cobre a resposta, a resposta vira introdução; se traz outra coisa, saem as duas", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const texts: string[] = [];
    const order: string[] = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { texts.push(a.text); order.push("texto"); return { sent: true }; });
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => {
      order.push(`ações:${actions.map((a) => a.type).join(",")}`);
      return { results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false };
    });
    const steps = [
      "Ana, para trocar o produto faça assim.",
      "Abra o aplicativo da loja e toque em Pedidos, escolha o pedido desejado e toque em Trocar.",
      "Confirme o endereço de coleta, imprima a etiqueta gerada, embale bem o produto e leve até a agência mais próxima da sua casa.",
      "Depois acompanhe a troca pela aba Pedidos do aplicativo, onde aparece cada etapa até a entrega do novo produto.",
    ].join(" ");
    mocks.callLLM.mockResolvedValue(llmOut({ reply: steps, actions: [{ type: "send_message_model", modelId: "mm-1" }] as any }));

    // Mensagem pronta de outro conteúdo (vídeo sobre cadastro): saem as duas.
    mocks.templateFindMany.mockResolvedValue([{ id: "mm-1", name: "Cadastro - vídeo", content: "Veja no vídeo como criar sua conta e cadastrar a senha." }]);
    await run("como troco o produto?");
    expect(texts.some((t) => t.includes("imprima a etiqueta"))).toBe(true);
    expect(order).toContain("ações:send_message_model");

    // Mensagem pronta com o mesmo passo a passo: a resposta vira só a introdução.
    texts.length = 0;
    order.length = 0;
    mocks.templateFindMany.mockResolvedValue([{ id: "mm-1", name: "Troca", content: "Abra o aplicativo da loja, toque em Pedidos, escolha o pedido desejado, toque em Trocar, confirme o endereço de coleta, imprima a etiqueta gerada, embale o produto e leve até a agência. Acompanhe a troca pela aba Pedidos do aplicativo até a entrega do novo produto." }]);
    await run("como troco o produto?");
    expect(texts.some((t) => t.includes("imprima a etiqueta"))).toBe(false);
    expect(order).toContain("ações:send_message_model");
  });

  it("modo da mensagem pronta: 'só a resposta' manda só os arquivos; 'só a mensagem pronta' reduz a resposta à introdução", async () => {
    const steps = [
      "Ana, para trocar o produto faça assim.",
      "Abra o aplicativo da loja e toque em Pedidos, escolha o pedido desejado e toque em Trocar.",
      "Confirme o endereço de coleta, imprima a etiqueta gerada, embale bem o produto e leve até a agência mais próxima da sua casa.",
      "Depois acompanhe a troca pela aba Pedidos do aplicativo, onde aparece cada etapa até a entrega do novo produto.",
    ].join(" ");
    const texts: string[] = [];
    let executed: Array<Record<string, unknown>> = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { texts.push(a.text); return { sent: true }; });
    mocks.executeActions.mockImplementation(async (actions: Array<Record<string, unknown>>) => {
      executed = actions;
      return { results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false };
    });
    mocks.templateFindMany.mockResolvedValue([{ id: "mm-1", name: "Cadastro - vídeo", content: "Veja no vídeo como criar sua conta." }]);
    mocks.callLLM.mockResolvedValue(llmOut({ reply: steps, actions: [{ type: "send_message_model", modelId: "mm-1" }] as any }));

    const answerOnly = baseConfig({ allowedMessageModelIds: ["mm-1"], messageModelMode: "answer" } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: answerOnly, active: true });
    await run("como troco o produto?");
    expect(texts.some((t) => t.includes("imprima a etiqueta"))).toBe(true);
    expect(executed.find((a) => a.type === "send_message_model")?.filesOnly).toBe(true);

    texts.length = 0;
    const modelOnly = baseConfig({ allowedMessageModelIds: ["mm-1"], messageModelMode: "message_model" } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: modelOnly, active: true });
    await run("como troco o produto?");
    expect(texts.some((t) => t.includes("imprima a etiqueta"))).toBe(false);
    expect(executed.find((a) => a.type === "send_message_model")?.filesOnly).toBeUndefined();
  });

  it("modo 'combinar': saem só os arquivos da mensagem pronta e o fecho vem depois deles", async () => {
    const config = baseConfig({
      allowedMessageModelIds: ["mm-1"],
      messageModelMode: "combine",
      replyEnding: { procedure: { enabled: true, phrases: ["Quando conseguir, me avise se deu certo."] }, info: { enabled: true, phrases: ["Posso ajudar em algo mais?"] } },
    } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.templateFindMany.mockResolvedValue([{ id: "mm-1", name: "Troca", content: "Veja o vídeo com o passo a passo." }]);
    const texts: string[] = [];
    let executed: Array<Record<string, unknown>> = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { texts.push(a.text); return { sent: true }; });
    mocks.executeActions.mockImplementation(async (actions: Array<Record<string, unknown>>) => {
      executed = actions;
      return { results: actions.map((a) => ({ action: a, ok: true, text: "", mediaSent: 1 })), anyHandoff: false, anyClose: false };
    });
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "Ana, para trocar o produto:\n1. Abra Pedidos.\n2. Toque em Trocar.\nVeja o vídeo com o passo a passo.",
      actions: [{ type: "send_message_model", modelId: "mm-1" }] as any,
    }));

    await run("como troco o produto?");

    expect(executed.find((a) => a.type === "send_message_model")?.filesOnly).toBe(true);
    expect(texts.some((t) => t.includes("Abra Pedidos"))).toBe(true);
    expect(texts.some((t) => t.includes("Quando conseguir, me avise se deu certo."))).toBe(true);
  });

  it("link de mensagem pronta liberada sai mesmo sem o envio dela; link que não está em conteúdo da empresa, não", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"], allowedDomains: ["loja.exemplo.com"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.templateFindMany.mockResolvedValue([{ id: "mm-1", name: "App", content: "Baixe o app: https://apps.outra.com/app?id=br.exemplo.app" }]);
    const texts: string[] = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { texts.push(a.text); return { sent: true }; });
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "Baixe o app pelo link https://apps.outra.com/app?id=br.exemplo.app e entre com seu e-mail. Mais detalhes em https://golpe.exemplo.net/x",
      actions: [],
    }));

    await run("onde baixo o aplicativo?");

    const all = texts.join("\n");
    expect(all).toContain("https://apps.outra.com/app?id=br.exemplo.app");
    expect(all).not.toContain("golpe.exemplo.net");
  });

  it("send_message_model com modelo fora da lista liberada é descartado", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-ok"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({
      actions: [
        { type: "send_message_model", modelId: "mm-ok" },
        { type: "send_message_model", modelId: "mm-inventado" },
      ] as any,
    }));

    await run("Me manda o procedimento");

    const executed = mocks.executeActions.mock.calls.at(-1)![0] as Array<{ modelId?: string }>;
    expect(executed.map((a) => a.modelId)).toEqual(["mm-ok"]);
  });

  it("mensagem sem resposta de um turno anterior continua no histórico", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut());
    mocks.messageFindMany.mockResolvedValue([
      { direction: "in", authorType: "contact", content: "oi?" },
      { direction: "in", authorType: "contact", content: "minha empresa está pedindo um comprovante" },
      { direction: "out", authorType: "bot", content: "Como posso ajudar?" },
    ]);

    await run("oi?");

    expect(mocks.callLLM.mock.calls[0][0].previousMessages).toEqual([
      { role: "assistant", content: "Como posso ajudar?" },
      { role: "user", content: "minha empresa está pedindo um comprovante" },
    ]);
  });

  it("mensagem pronta sai depois da reply; não sai quando o turno transfere", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"], enabledTools: ["add_tag"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const order: string[] = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { order.push(`texto:${a.text}`); return { sent: true }; });
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => {
      order.push(`ações:${actions.map((a) => a.type).join(",")}`);
      return { results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false };
    });
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "Vou te mandar o tutorial:",
      actions: [{ type: "send_message_model", modelId: "mm-1" }, { type: "add_tag", tag: "x" }] as any,
    }));

    await run("Como faço o acesso?");

    expect(order).toEqual(["ações:add_tag", "texto:Vou te mandar o tutorial:", "ações:send_message_model"]);

    order.length = 0;
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "x",
      handoff: true,
      actions: [{ type: "send_message_model", modelId: "mm-1" }] as any,
    }));
    await run("Quero falar com alguém sobre o acesso");
    expect(order.some((o) => o.includes("send_message_model"))).toBe(false);
  });

  it("cliente na fila escreve de novo: só avisa que está na fila e devolve à fila (padrão)", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active", "pessoa"));
    mocks.pendingFindFirst.mockResolvedValueOnce({ id: "pend-1" });
    await run("Qual o prazo?");
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).toContain("fila");
    expect(mocks.conversationUpdateMany).toHaveBeenCalled();
  });

  it("cliente na fila, modo responder: responde; se transferir de novo, o aviso é o de fila", async () => {
    const config = baseConfig({ handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: [], whileQueued: "answer", queuedMessage: "Aguarde na fila, por favor." } } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active", "pessoa"));
    mocks.pendingFindFirst.mockResolvedValueOnce({ id: "pend-1" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "x", handoff: true }));
    await run("Qual o prazo da minha solicitação?");
    expect(mocks.callLLM).toHaveBeenCalled();
    const texts = mocks.sendText.mock.calls.map((c) => c[0].text as string);
    expect(texts).toContain("Aguarde na fila, por favor.");
    expect(texts).not.toContain("Vou transferir.");
  });

  it("cliente manda só \"?\": refaz a pergunta em vez de transferir (padrão)", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.messageFindMany.mockResolvedValue([
      { direction: "in", authorType: "contact", content: "?" },
      { direction: "out", authorType: "bot", content: "Entendi. Qual documento você precisa enviar?" },
      { direction: "in", authorType: "contact", content: "preciso enviar documentos" },
    ]);
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Vou transferir.", handoff: true }));
    await run("?");
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).toContain("Desculpa, acho que não fui claro.");
  });

  it("depois de encerrar: pergunta com botões uma vez; \"Oi\" de novo não repete a pergunta", async () => {
    const config = baseConfig({ closure: { ambiguousBehavior: "ask_with_options" } } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const closedState = (counters: Record<string, unknown> = {}) => ({
      ...makeState("closed", "ninguem", counters),
      postCloseWindowEndAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    mocks.getState.mockResolvedValue(closedState());
    await run("Oi");
    const first = mocks.sendText.mock.calls.at(-1)![0] as { text: string; interactive?: { kind: string; options: Array<{ title: string }> } };
    expect(first.interactive?.kind).toBe("buttons");
    expect(first.interactive?.options.map((o) => o.title)).toEqual(["Preciso de ajuda", "Só agradecer"]);
    expect(first.text).toContain("1. Preciso de ajuda");
    const saved = mocks.upsertState.mock.calls.map((c) => c[0]).find((a: { counters?: { pendingOptions?: string[] } }) => a.counters?.pendingOptions);
    expect(saved.counters.pendingOptions).toEqual(["Preciso de ajuda", "Só agradecer"]);

    mocks.sendText.mockClear();
    mocks.getState.mockResolvedValue(closedState({ pendingOptions: ["Preciso de ajuda", "Só agradecer"] }));
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Claro! Em que posso ajudar?" }));
    await run("Oi");
    const texts = mocks.sendText.mock.calls.map((c) => c[0].text as string);
    expect(texts.join("|")).not.toContain("Você precisa de ajuda com algo novo?");
    expect(mocks.callLLM).toHaveBeenCalled();
  });

  it("depois de encerrar: \"valeu\" recebe a mensagem de agradecimento, não o aviso de transferência", async () => {
    const config = baseConfig({
      closure: {
        courtesyBehavior: "short_reply",
        newDemandBehavior: "handoff",
        postCloseMessages: { courtesy: "Por nada!", new_demand: "Vou te passar para a equipe." },
      },
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("closed", "ninguem"), postCloseWindowEndAt: new Date(Date.now() + 3600_000) });
    await run("valeu");
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string)).toEqual(["Por nada!"]);
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();

    mocks.sendText.mockClear();
    await run("Preciso de ajuda com outra coisa");
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string)).toContain("Vou te passar para a equipe.");
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("depois de encerrar: a pergunta não se repete na mesma janela", async () => {
    const config = baseConfig({ closure: { ambiguousBehavior: "ask_with_options" } } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("closed", "ninguem", { postCloseAsked: true }), postCloseWindowEndAt: new Date(Date.now() + 3600_000) });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Me conta o que você precisa." }));
    await run("??");
    const texts = mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|");
    expect(texts).not.toContain("Você precisa de ajuda com algo novo?");
    expect(mocks.callLLM).toHaveBeenCalled();
  });

  it("saudação que ficou para trás (o cliente já mandou o pedido) não sai", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    let newer: Array<{ content: string; messageType: string }> = [{ content: "quero trocar de plano", messageType: "text" }];
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] }; direction?: string } }) =>
      args?.where?.id?.in ? [{ createdAt: new Date("2026-09-26T12:08:00Z") }] : args?.where?.direction === "in" ? newer : [],
    );
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Oi, Maria! Boa tarde 😊 Como posso ajudar você hoje?" }));
    await run("Oi, boa tarde!", { messageIds: ["m-1"] });
    expect(mocks.sendText).not.toHaveBeenCalled();

    // Sem mensagem nova, a saudação sai normalmente.
    newer = [];
    await run("Oi, boa tarde!", { messageIds: ["m-1"] });
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).toContain("Como posso ajudar");
  });

  it("'?' que chegou enquanto ele respondia a anterior não recebe outra resposta", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? [{ createdAt: new Date("2026-09-26T13:15:30Z") }] : [],
    );
    // Resposta do agente saiu depois do "?".
    mocks.messageFindFirst.mockResolvedValue({ id: "out-1" });
    await run("?", { messageIds: ["m-2"] });
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.logTurn.mock.calls.at(-1)![0].discardedActions).toEqual([{ type: "no_reply", reason: "answered meanwhile" }]);

    // Com pedido de verdade, responde normalmente.
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Claro, o prazo é de 5 dias úteis." }));
    await run("e qual o prazo?", { messageIds: ["m-3"] });
    expect(mocks.callLLM).toHaveBeenCalled();
    mocks.messageFindFirst.mockReset();
    mocks.messageFindFirst.mockImplementation(async () => null);

    const { isFillerMessage } = await import("../engine");
    for (const m of ["?", "??", "oi", "alô?", "Boa tarde!"]) expect(isFillerMessage(m)).toBe(true);
    for (const m of ["", "quero trocar de plano", "e o prazo?"]) expect(isFillerMessage(m)).toBe(false);
  });

  it("saudação confere de novo depois do 'digitando…'; resposta com conteúdo não", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? [{ createdAt: new Date("2026-09-26T12:08:00Z") }] : [],
    );
    mocks.messageFindFirst.mockResolvedValue(null);
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Oi, Maria! Boa tarde 😊 Como posso ajudar você hoje?" }));
    await run("Oi, boa tarde!", { messageIds: ["m-1"] });
    const hb = mocks.sendText.mock.calls.at(-1)![0].humanBehavior as { abortIf?: () => Promise<boolean>; turnStartedAt?: number };
    expect(typeof hb.abortIf).toBe("function");
    expect(typeof hb.turnStartedAt).toBe("number");
    // O pedido chega durante o "digitando…": a saudação desiste.
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] }; direction?: string } }) =>
      args?.where?.id?.in
        ? [{ createdAt: new Date("2026-09-26T12:08:00Z") }]
        : args?.where?.direction === "in" ? [{ content: "Preciso da segunda via", messageType: "text" }] : [],
    );
    await expect(hb.abortIf!()).resolves.toBe(true);

    mocks.sendText.mockClear();
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "O boleto fica na área de pagamentos, no menu Financeiro." }));
    await run("Preciso do boleto", { messageIds: ["m-2"] });
    expect((mocks.sendText.mock.calls.at(-1)![0].humanBehavior as { abortIf?: unknown }).abortIf).toBeUndefined();
    mocks.messageFindFirst.mockReset();
    mocks.messageFindFirst.mockImplementation(async () => null);
  });

  it("sem confirmação: só cumprimento recebe as boas-vindas configuradas; com pedido, responde direto", async () => {
    const config = baseConfig({
      entry: { confirmContact: false, onDealNotFound: "ask_identification", openingEnabled: true, openingMessage: "Olá! Sou a assistente virtual. Como posso te ajudar?" },
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("idle"));
    await run("Oi, boa tarde!");
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string)).toEqual(["Olá! Sou a assistente virtual. Como posso te ajudar?"]);

    mocks.sendText.mockClear();
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Para emitir o boleto, acesse a área de pagamentos." }));
    await run("Oi, preciso do boleto");
    expect(mocks.callLLM).toHaveBeenCalled();
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).not.toContain("assistente virtual");
  });

  it("fecho vai depois da mensagem pronta, não na apresentação", async () => {
    const config = baseConfig({
      allowedMessageModelIds: ["mm-1"],
      replyEnding: { procedure: { enabled: true, phrases: ["Me avisa se funcionou."] }, info: { enabled: true, phrases: ["Posso ajudar em algo mais?"] } },
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const order: string[] = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { order.push(`texto:${a.text}`); return { sent: true }; });
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => {
      if (actions.length) order.push(`ações:${actions.map((a) => a.type).join(",")}`);
      return {
        results: actions.map((a) => ({ action: a, ok: true, text: "Tutorial:\n1️⃣ Abra o app.\n2️⃣ Toque em Pedidos." })),
        anyHandoff: false,
        anyClose: false,
      };
    });
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "Vou te enviar um tutorial rápido.",
      actions: [{ type: "send_message_model", modelId: "mm-1" }] as any,
    }));

    await run("Preciso de ajuda para acessar o aplicativo");

    expect(order).toEqual(["texto:Vou te enviar um tutorial rápido.", "ações:send_message_model", "texto:Me avisa se funcionou."]);
  });

  it("mesma mensagem pronta pedida de novo logo depois: não reenvia e aponta a de cima", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.recentlySent.mockResolvedValueOnce(new Set(["mm-1"]));
    const order: string[] = [];
    mocks.sendText.mockImplementation(async (a: { text: string }) => { order.push(`texto:${a.text}`); return { sent: true }; });
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => {
      if (actions.length) order.push(`ações:${actions.map((a) => a.type).join(",")}`);
      return { results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false };
    });
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "Vou te enviar um tutorial rápido.",
      actions: [{ type: "send_message_model", modelId: "mm-1" }] as any,
    }));

    await run("Preciso de ajuda para acessar o aplicativo");

    expect(order.some((o) => o.includes("send_message_model"))).toBe(false);
    expect(order.join("|")).toContain("logo acima");
    expect(order.join("|")).not.toContain("Vou te enviar");
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
  });

  it("mensagem pronta barrada só por repetir uma recente não transfere", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const { MESSAGE_MODEL_REPEATED } = await import("../sent-materials");
    mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => ({
      results: actions.map((a) => (a.type === "send_message_model" ? { action: a, ok: false, error: MESSAGE_MODEL_REPEATED } : { action: a, ok: true })),
      anyHandoff: false,
      anyClose: false,
    }));
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Segue o material.", actions: [{ type: "send_message_model", modelId: "mm-1" }] as any }));
    await run("manda o material");
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
  });

  it("histórico não repete as bolhas do turno atual", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut());
    // findMany vem em ordem decrescente (mais nova primeiro).
    mocks.messageFindMany.mockResolvedValue([
      { direction: "in", authorType: "contact", content: "de ajuda" },
      { direction: "in", authorType: "contact", content: "preciso" },
      { direction: "out", authorType: "bot", content: "Como posso ajudar?" },
      { direction: "in", authorType: "contact", content: "Oi" },
    ]);

    await run("preciso\nde ajuda");

    expect(mocks.callLLM.mock.calls[0][0].previousMessages).toEqual([
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Como posso ajudar?" },
    ]);
  });

  const sentTexts = () => mocks.sendText.mock.calls.map((c) => (c[0] as { text: string }).text);

  it("o outro agente passou a conversa para pessoa e a fila nasceu nessa transferência: este agente não assume, devolve à fila e não responde", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-anterior", updatedAt: new Date("2026-10-10T10:21:56.900Z") });
    mocks.pendingFindFirst.mockResolvedValueOnce({ id: "pend-fila", createdAt: new Date("2026-10-10T10:21:56.805Z") } as { id: string });
    await run("Obrigada, fico no aguardo!");
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual([]);
    expect(mocks.conversationUpdateMany).toHaveBeenCalled();
  });

  it("conversa recebida de outro agente de IA: assume e responde, mesmo com pendência de fila antiga", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-anterior" });
    mocks.pendingFindFirst.mockResolvedValueOnce({ id: "pend-velha" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "O desconto aparece no corpo da fatura." }));
    await run("o valor da fatura veio diferente");
    expect(mocks.callLLM).toHaveBeenCalled();
    expect(sentTexts()).toEqual(["O desconto aparece no corpo da fatura."]);
    expect(mocks.conversationUpdateMany).not.toHaveBeenCalled();
  });

  it("'não sou eu' com negócio carregado: não chama o modelo com os dados do cadastro", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("identifying"), identificationAttempts: 1 });
    await run("como assim?");
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
    await run("sou o marido, o documento dela é 123.456.789-00");
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
  });

  it("cliente irritado: a resposta útil sai antes do aviso de transferência", async () => {
    const config = baseConfig({ sentiment: { enabled: true, threshold: "any", action: "handoff" } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Seu pedido saiu hoje e chega amanhã." }));
    await run("isso está péssimo");
    expect(sentTexts()).toEqual(["Seu pedido saiu hoje e chega amanhã.", "Vou transferir."]);
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("fora do escopo: aviso uma vez, depois silêncio; voltou ao assunto, responde", async () => {
    const config = baseConfig({ limits: { nonsenseLimit: 2, nonsenseAction: "warn_and_silence", maxLoopCount: 99 } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Isso eu não atendo.", outOfScope: true }));
    // 2ª fora do escopo: aviso.
    mocks.getState.mockResolvedValue(makeState("active", "agente", { nonsenseMessages: 1 }));
    await run("me conta uma piada");
    expect(sentTexts()).toHaveLength(1);
    // 3ª: silêncio (antes o aviso saía de novo).
    mocks.sendText.mockClear();
    mocks.getState.mockResolvedValue(makeState("active", "agente", { nonsenseMessages: 2 }));
    await run("e outra piada");
    expect(sentTexts()).toEqual([]);
    // Voltou ao assunto: responde.
    mocks.sendText.mockClear();
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "O prazo é de 3 dias úteis." }));
    await run("qual o prazo de entrega?");
    expect(sentTexts()).toEqual(["O prazo é de 3 dias úteis."]);
  });

  it("nada nos materiais e resposta com fato: mensagem 'sem material', sem fecho", async () => {
    const config = baseConfig({
      fallback: { noSource: { message: "Essa informação eu não tenho por aqui." } },
      replyEnding: { info: { enabled: true, phrases: ["Posso ajudar em algo mais?"] } },
    } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const { noteV2Fact } = await import("../trace");
    mocks.callLLM.mockImplementation(async () => {
      noteV2Fact("prefetch", { searchable: true, searched: true, found: 0 });
      return llmOut({ reply: "A entrega internacional leva 20 dias." });
    });
    await run("vocês entregam fora do país?");
    expect(sentTexts()).toEqual(["Essa informação eu não tenho por aqui."]);
    mocks.callLLM.mockReset();
  });

  it("sentimento com \"apenas registrar\" não transfere", async () => {
    const config = baseConfig({ sentiment: { enabled: true, threshold: "any", action: "log_only" } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut());
    await run("isso está péssimo");
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
    expect(sentTexts()).toContain("Resposta do agente.");
  });

  it("transferir e encerrar no mesmo turno: transfere", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ handoff: true, concluded: true }));
    await run("quero falar com alguém");
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("assunto com transferência direta não chama o modelo", async () => {
    const config = baseConfig({
      themes: [{ id: "fin", name: "Financeiro", when: ["segunda via"], examples: [], instructions: "", allowedTools: [], directHandoff: true }],
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    await run("preciso da segunda via");
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("avisar e silenciar: no limite o cliente recebe o aviso", async () => {
    const config = baseConfig({ limits: { ...baseConfig().limits, nonsenseLimit: 1, nonsenseAction: "warn_and_silence" } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ outOfScope: true, reply: "Isso não é comigo." }));
    await run("quanto é 2+2");
    expect(sentTexts().some((t) => t.includes("só consigo ajudar com o atendimento"))).toBe(true);
    expect(sentTexts()).not.toContain("Isso não é comigo.");
  });

  it("mensagem pronta pedida e não liberada: transfere em vez de anunciar o que não vai chegar", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-ok"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Segue o material:", actions: [{ type: "send_message_model", modelId: "mm-inventado" }] as any }));
    await run("me manda o material");
    expect(sentTexts()).not.toContain("Segue o material:");
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("erro do modelo usa a mensagem de erro técnico configurada", async () => {
    const config = baseConfig({ fallback: { error: { message: "Tive um problema técnico, já chamo alguém." } } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockRejectedValue(new Error("timeout"));
    await run("oi");
    expect(sentTexts()).toContain("Tive um problema técnico, já chamo alguém.");
  });

  it("texto + áudio com \"pedir texto\": responde o texto em vez de pedir para escrever", async () => {
    const config = baseConfig({ media: { ...baseConfig().media, audio: { action: "ask_text", askTextMessage: "Pode escrever?" } } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut());
    await run(["tenho uma dúvida sobre o boleto", "[Áudio]"].join("\n"), { messageType: "audio" });
    expect(mocks.callLLM).toHaveBeenCalled();
    expect(sentTexts()).not.toContain("Pode escrever?");
    // O modelo sabe que o áudio ficou de fora e avisa o cliente.
    expect(JSON.stringify(mocks.callLLM.mock.calls[0])).toContain("não dá para ouvir");
  });

  it("imagem com legenda e imagem seguida de texto: a política de imagem vale (não só o tipo da última bolha)", async () => {
    const config = baseConfig({ media: { ...baseConfig().media, image: { action: "handoff" } } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    // Legenda: o texto do turno é só "Aparece assim", a mensagem é imagem.
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? [{ messageType: "image", createdAt: new Date("2026-09-26T12:00:00Z") }] : [],
    );
    await run("Aparece assim", { messageIds: ["m-1"], messageType: "image" });
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM).not.toHaveBeenCalled();

    // Imagem e depois texto: o turno é "text", mas tem imagem.
    mocks.simpleHandoff.mockClear();
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in
        ? [{ messageType: "image", createdAt: new Date("2026-09-26T12:00:00Z") }, { messageType: "text", createdAt: new Date("2026-09-26T12:00:01Z") }]
        : [],
    );
    await run("[Imagem]\nAparece isso", { messageIds: ["m-2", "m-3"], messageType: "text" });
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
    mocks.messageFindMany.mockReset();
  });

  it("encerrar sem despedida configurada: a resposta do modelo sai (antes o cliente ficava sem nada)", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Combinado! Qualquer coisa, é só chamar.", concluded: true }));
    await run("Obrigada, vou fazer");
    expect(sentTexts()).toContain("Combinado! Qualquer coisa, é só chamar.");

    // Com despedida configurada, sai só a despedida.
    mocks.sendText.mockClear();
    const withGoodbye = baseConfig({ closure: { goodbyeMessage: "Até mais!" } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: withGoodbye, active: true });
    await run("Obrigada, vou fazer");
    expect(sentTexts()).toEqual(["Até mais!"]);
  });

  it("só áudio com \"pedir texto\": pede para escrever", async () => {
    const config = baseConfig({ media: { ...baseConfig().media, audio: { action: "ask_text", askTextMessage: "Pode escrever?" } } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    await run("[Áudio]", { messageType: "audio" });
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(sentTexts()).toContain("Pode escrever?");
  });

  it("resposta barrada pela trava anti-repetição: manda outra e o log não finge que enviou", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Mesma resposta de antes." }));
    mocks.sendText
      .mockResolvedValueOnce({ sent: false, reason: "near_duplicate" })
      .mockResolvedValue({ sent: true });
    await run("?");
    // Sem explicação anterior na conversa: a saída não pergunta se ficou dúvida.
    expect(sentTexts()[1]).toContain("Me conta");
    expect(sentTexts()[1]).not.toContain("Ficou alguma dúvida");
    const logged = mocks.logTurn.mock.lastCall![0] as { reply?: string };
    expect(logged.reply).toContain("Me conta");
  });

  it("explicação barrada por repetição: o envio ignora o fecho e a saída pergunta o que ficou confuso", async () => {
    const endingPhrase = "Posso te ajudar em mais alguma coisa?";
    const config = baseConfig({ replyEnding: { info: { enabled: true, phrases: [endingPhrase] } } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({
      reply: "Para gerar o pagamento, acesse o painel, toque em Pagamentos, escolha o título desejado e selecione boleto ou cartão para concluir o pagamento ainda hoje pelo aplicativo.",
    }));
    mocks.sendText
      .mockResolvedValueOnce({ sent: false, reason: "near_duplicate" })
      .mockResolvedValue({ sent: true });
    // Mensagem anterior do agente era só uma pergunta curta: antes a saída
    // virava "me conta o que você precisa" logo depois de o cliente dizer.
    await run("Gerar o pagamento");
    const firstSend = mocks.sendText.mock.calls[0][0] as { text: string; dedupeIgnore?: string[] };
    expect(firstSend.text).toContain(endingPhrase);
    expect(firstSend.dedupeIgnore).toContain(endingPhrase);
    expect(sentTexts()[1]).toContain("Ficou alguma dúvida");
  });

  describe("repetição e encerramento: o agente responde e só encerra com confirmação explícita", () => {
    const loopConfig = () => baseConfig({ limits: { maxLoopCount: 3, nonsenseAction: "warn_and_silence" } } as unknown as Partial<V2AgentConfig>);

    it("conversa recebida de outro agente: a mesma mensagem não conta como repetição", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: loopConfig(), active: true });
      // Dois agentes já processaram esta mensagem (contador herdado = 2); este é o terceiro.
      mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa", { loopCount: 2, lastLoopMessage: "qual o prazo de entrega?" }), agentId: "agent-0" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "O prazo de entrega é de 5 dias úteis." }));

      await run("Qual o prazo de entrega?");

      expect(mocks.callLLM).toHaveBeenCalled();
      expect(sentTexts()).toContain("O prazo de entrega é de 5 dias úteis.");
      expect(sentTexts().join(" ")).not.toContain("Recebi a mesma mensagem");
      const saved = mocks.upsertState.mock.calls.map((c) => c[0] as { counters?: { loopCount?: number } }).filter((c) => c.counters);
      // Para este agente a mensagem é a primeira (contador 1), não a terceira.
      expect(saved.at(-1)?.counters?.loopCount).toBe(1);
    });

    it("pergunta com conteúdo repetida: a resposta do modelo sai no lugar do aviso de loop", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: loopConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { loopCount: 2, lastLoopMessage: "posso pagar o valor até o dia 26?" }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Sim, o valor vale até o dia 26." }));

      await run("Posso pagar o valor até o dia 26?");

      expect(sentTexts()).toContain("Sim, o valor vale até o dia 26.");
      expect(sentTexts().join(" ")).not.toContain("Recebi a mesma mensagem");
    });

    it("mensagem curta repetida continua recebendo o aviso de loop", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: loopConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { loopCount: 2, lastLoopMessage: "oi" }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Oi! Como posso ajudar?" }));

      await run("Oi");

      expect(sentTexts().join(" ")).toContain("Recebi a mesma mensagem");
      expect(sentTexts()).not.toContain("Oi! Como posso ajudar?");
    });

    it("\"Ok\" depois de uma orientação não encerra, mesmo que o modelo queira", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Que bom que consegui te ajudar!", concluded: true }));

      const result = await run("Ok");

      expect(result.closed).toBe(false);
      expect(mocks.resolveInline).not.toHaveBeenCalled();
    });

    it("confirmação explícita encerra", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Que bom! Qualquer coisa, é só chamar.", concluded: true }));

      const result = await run("Resolvido, obrigada!");

      expect(result.closed).toBe(true);
    });

    it("resumo ao encerrar: gravado antes de fechar, com o motivo", async () => {
      const config = baseConfig({ closure: { ...baseConfig().closure, summary: { enabled: true, verbosity: "standard", everyTurn: false } } } as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Que bom! Até mais.", concluded: true }));

      const result = await run("Resolvido, obrigada!");

      expect(result.closed).toBe(true);
      expect(mocks.writeSummary).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", moment: "close", reason: "resolved" }));
    });

    it("resumo ao transferir: gravado com o tipo do destino", async () => {
      const config = baseConfig({ closure: { ...baseConfig().closure, summary: { enabled: true, verbosity: "minimal", everyTurn: false } } } as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Vou te passar para a equipe.", handoff: true }));

      const result = await run("Quero falar com uma pessoa");

      expect(result.handoff).toBe(true);
      expect(mocks.writeSummary).toHaveBeenCalledWith(expect.objectContaining({ moment: "transfer", reason: expect.any(String) }));
    });

    it("resumo do atendimento anterior entra no contexto do modelo", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.loadPriorSummary.mockResolvedValue({ text: "Motivo: pedido atrasado\nResultado: Encerrado por inatividade", at: new Date("2026-01-01"), agent: "Agente", current: false });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Sim, o pedido pode ser pago até o dia 10." }));

      await run("Posso pagar até o dia 10?");

      const args = mocks.callLLM.mock.calls[0][0] as { priorSummary?: { text: string } | null };
      expect(args.priorSummary?.text).toContain("pedido atrasado");
    });

    it("desligado: nada é gravado", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Até mais.", concluded: true }));

      await run("Resolvido, obrigada!");

      // O módulo decide pelo config; aqui só confirmamos que o gancho passa o config desligado.
      const call = mocks.writeSummary.mock.calls[0]?.[0] as { config?: { closure?: { summary?: unknown } } } | undefined;
      expect(call?.config?.closure?.summary).toBeUndefined();
    });

    it("confirmação curta não ganha o fecho com botões", async () => {
      const config = baseConfig({ replyEnding: { info: { enabled: true, phrases: ["Posso te ajudar em mais alguma coisa?"], buttons: ["Não", "Preciso de ajuda"] } } } as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Combinado!" }));

      await run("Ok, obrigado");

      expect(sentTexts()).toEqual(["Combinado!"]);
      expect(sentTexts().join(" ")).not.toContain("Posso te ajudar");
    });

    it("depois de 'me conta o que você precisa', a frase transfere com o assunto", async () => {
      const config = baseConfig({ handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["atendente"] } } as unknown as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { humanRequestAsked: true, humanRequestPending: true }));

      const result = await run("Problemas com a solicitação do documento");

      expect(result.handoff).toBe(true);
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(sentTexts()).toContain("Vou transferir.");
    });

    it("'já tentei e não deu certo' depois de uma orientação: transfere, sem reenviar material", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { guidanceGiven: true }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Siga de novo os passos: 1. Abra o painel. 2. Envie a solicitação.", actions: [{ type: "send_message_model", modelId: "m-1" }] }));

      const result = await run("Já tentei 3 vezes e deu erro de novo");

      expect(result.handoff).toBe(true);
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(sentTexts().join(" ")).toContain("já tentou e não deu certo");
      expect(sentTexts().join(" ")).not.toContain("Siga de novo");
    });

    it("pedido de ajuda depois de uma orientação transfere na hora, sem perguntar o assunto", async () => {
      const config = baseConfig({ handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["preciso de ajuda"] } } as unknown as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { guidanceGiven: true, pendingOptions: ["Funcionou!", "Preciso de ajuda"] }));

      const result = await run("Preciso de ajuda");

      expect(result.handoff).toBe(true);
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(sentTexts().join(" ")).toContain("já tentou e não deu certo");
      expect(sentTexts().join(" ")).not.toContain("me conta em uma frase");
    });

    it("pergunta com botões não sai se o cliente escreveu enquanto o agente pensava", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "O contrato é novo ou renovação?" }));
      mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] }; direction?: string } }) =>
        args.where?.id?.in
          ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }]
          : args.where?.direction === "in" ? [{ content: "É renovação, e já tentei duas vezes", messageType: "text" }] : [],
      );

      await run("Não consigo concluir a solicitação", { messageIds: ["m-cur"] });

      expect(sentTexts()).toEqual([]);
    });

    it("clique repetido na opção que acabou de ser respondida não vira turno", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.messageFindMany.mockImplementation(async (args: { take?: number }) =>
        args.take === 3
          ? [
              { direction: "out", content: "Sua dúvida é sobre o documento ou o prazo?", messageType: "interactive" },
              { direction: "in", content: "Contrato novo", messageType: "interactive" },
            ]
          : [],
      );

      const result = await run("Contrato novo", { messageType: "interactive", messageIds: ["m-cur"] });

      expect(result).toEqual({ handoff: false, closed: false });
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(sentTexts()).toEqual([]);
    });

    it("atalho com mensagem fixa responde uma vez: na segunda vez a mensagem vai para o agente", async () => {
      const config = baseConfig({
        rules: [{ id: "r-fixo", name: "Assinatura", order: 1, conditions: [{ type: "keywords", values: ["assinatura"] }], actions: [{ type: "send_message", message: "A assinatura é feita no portal, com os dados de acesso." }] } as any],
      });
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => ({ results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Entendi: seu e-mail de acesso não está sendo aceito. Me diga qual mensagem aparece." }));

      // Primeira vez: o atalho responde e marca que uma orientação foi dada.
      await run("Como faço a assinatura?");
      expect(mocks.callLLM).not.toHaveBeenCalled();
      const saved = mocks.upsertState.mock.calls.map((c) => c[0] as { counters?: { guidanceGiven?: boolean } }).filter((c) => c.counters);
      expect(saved.at(-1)?.counters?.guidanceGiven).toBe(true);

      // Segunda vez (mesma palavra-chave, dúvida diferente): o atalho já respondeu → agente responde.
      vi.clearAllMocks();
      mocks.sendText.mockResolvedValue({ sent: true });
      mocks.upsertState.mockResolvedValue(undefined);
      mocks.logTurn.mockResolvedValue(undefined);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { guidanceGiven: true }));
      mocks.appliedRules.mockResolvedValue(new Set(["r-fixo"]));
      mocks.loadPriorSummary.mockResolvedValue(null);
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Entendi: seu e-mail de acesso não está sendo aceito. Me diga qual mensagem aparece." }));

      await run("A assinatura não aceita meu e-mail");

      expect(mocks.callLLM).toHaveBeenCalled();
      expect(sentTexts()).toEqual(["Entendi: seu e-mail de acesso não está sendo aceito. Me diga qual mensagem aparece."]);
    });

    it("resposta com conteúdo sai mesmo que o cliente escreva no meio; só a pergunta de triagem espera", async () => {
      const config = baseConfig({ replyEnding: { info: { enabled: true, phrases: ["Posso te ajudar em mais alguma coisa?"], buttons: ["Não", "Preciso de ajuda"] } } } as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Nas atividades não aparece qual questão você acertou. A nota fica em Resultados." }));
      mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] }; direction?: string } }) =>
        args.where?.id?.in
          ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }]
          : args.where?.direction === "in" ? [{ content: "e onde vejo a nota?", messageType: "text" }] : [],
      );

      await run("Não consigo ver o que errei", { messageIds: ["m-cur"] });

      expect(sentTexts()).toHaveLength(1);
      expect(sentTexts()[0]).toContain("Nas atividades não aparece");
      expect(sentTexts()[0]).toContain("Posso te ajudar em mais alguma coisa?");
    });

    it("turno copiado de outro agente: atalho não responde em cima da resposta que o anterior já deu", async () => {
      const config = baseConfig({
        rules: [{ id: "r-kw", name: "Palavra", order: 1, conditions: [{ type: "keywords", values: ["assinatura"] }], actions: [{ type: "send_message", message: "Texto fixo." }] } as any],
      });
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "pessoa"), agentId: "agent-0" });
      mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
        args.where?.id?.in ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }] : [],
      );
      // Já existe resposta do agente anterior depois da mensagem.
      mocks.messageFindFirst.mockResolvedValue({ id: "m-prev-reply" });
      mocks.executeActions.mockImplementation(async (actions: Array<{ type: string }>) => ({ results: actions.map((a) => ({ action: a, ok: true })), anyHandoff: false, anyClose: false }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Seu e-mail de acesso é o acadêmico; me diga qual mensagem aparece." }));

      await run("A assinatura não aceita meu e-mail", { messageIds: ["m-cur"] });

      expect(mocks.callLLM).toHaveBeenCalled();
      expect(sentTexts().join(" ")).not.toContain("Texto fixo.");
    });

    it("agradecimento à transferência não engole a pergunta do agente novo", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "agente"), agentId: "agent-0" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "A troca é feita pelo portal. Você já tem acesso ao portal?" }));
      // Depois da pergunta (copiada do agente anterior) só chegou um "Obrigada".
      mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] }; direction?: string } }) =>
        args.where?.id?.in
          ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }]
          : args.where?.direction === "in" ? [{ content: "Obrigada", messageType: "text" }] : [],
      );

      await run("Como troco o titular do plano?", { messageIds: ["m-cur"] });

      expect(sentTexts()).toHaveLength(1);
      expect(sentTexts()[0]).toContain("Você já tem acesso ao portal?");
    });

    it("turno de mensagem antiga, depois de a conversa seguir, não responde de novo", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "agente"), agentId: "agent-0" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "O prazo de setembro já passou; a próxima janela é em dezembro." }));
      // Depois desta mensagem veio outra com conteúdo, e ela já foi respondida.
      mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] }; direction?: string } }) =>
        args.where?.id?.in
          ? [{ createdAt: new Date("2026-01-01T10:00:00Z") }]
          : args.where?.direction === "in"
            ? [{ createdAt: new Date("2026-01-01T10:00:06Z"), content: "É possível fazer hoje?", messageType: "text" }]
            : [],
      );
      mocks.messageFindFirst.mockResolvedValue({ id: "out-1" });

      await run("Perdi o prazo de setembro", { messageIds: ["m-old"] });

      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(sentTexts()).toHaveLength(0);
      expect(mocks.logTurn.mock.calls.at(-1)![0].discardedActions).toEqual([{ type: "no_reply", reason: "conversation moved on" }]);
    });

    it("encerramento pelo agente não dispara fluxos \"Conversa encerrada\"", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { pendingOptions: ["Não, obrigado(a)!", "Preciso de ajuda"] }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Combinado! Até mais.", concluded: true }));

      const result = await run("Não, obrigado(a)!");

      expect(result.closed).toBe(true);
      expect(mocks.resolveInline).toHaveBeenCalledWith(expect.objectContaining({ skipAutomations: true }));
    });

    const PROBING_THEME = {
      id: "t-dec",
      name: "Decisão",
      instructions: "Entenda o motivo antes de encaminhar.",
      when: ["quero cancelar"],
      examples: [],
      allowedTools: [],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      knowledgeDocIds: [],
      messageModelIds: [],
      productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
      handoffDestination: { type: "department", id: "dep-dec", message: "Vou te passar para o setor responsável, que segue com você." },
    };

    it("perguntas seguidas sem resolver: no limite, a próxima pergunta vira a saída do assunto", async () => {
      const config = baseConfig({ themes: [PROBING_THEME as any], limits: { ...baseConfig().limits, maxStalledExchanges: 2, stalledExchangesAction: "handoff" } } as any);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "agente", { stalledExchanges: 2 }), themeId: "t-dec" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "A rotina corrida pesa mesmo. Essa flexibilidade poderia ajudar você a continuar?", theme: "t-dec" }));

      const result = await run("Falta de tempo");

      expect(result.handoff).toBe(true);
      expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: expect.objectContaining({ type: "department", id: "dep-dec" }) }));
      expect(sentTexts().join(" ")).toContain("Vou te passar para o setor responsável");
      expect(sentTexts().join(" ")).not.toContain("poderia ajudar você a continuar?");
    });

    it("pergunta seguida sem resolver conta; orientação ou dado coletado zera", async () => {
      const config = baseConfig({ themes: [PROBING_THEME as any], limits: { ...baseConfig().limits, maxStalledExchanges: 2 } } as any);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      const saved = () => mocks.upsertState.mock.calls.map((c) => c[0] as { counters?: { stalledExchanges?: number } }).filter((c) => c.counters).at(-1)?.counters?.stalledExchanges;

      mocks.getState.mockResolvedValue({ ...makeState("active", "agente", { stalledExchanges: 1 }), themeId: "t-dec" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Entendo. O que tem dificultado: tempo, acesso ou outra situação?", theme: "t-dec" }));
      await run("Não estou conseguindo acompanhar");
      expect(sentTexts().join(" ")).toContain("O que tem dificultado");
      expect(saved()).toBe(2);

      vi.clearAllMocks();
      mocks.sendText.mockResolvedValue({ sent: true });
      mocks.upsertState.mockResolvedValue(undefined);
      mocks.logTurn.mockResolvedValue(undefined);
      mocks.loadPriorSummary.mockResolvedValue(null);
      mocks.appliedRules.mockResolvedValue(new Set());
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "agente", { stalledExchanges: 2 }), themeId: "t-dec" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Para pausar, siga estes passos:\n1. Entre no portal\n2. Abra Solicitações\n3. Escolha Pausa e confirme\n\nQuer que eu te mande o link?", theme: "t-dec" }));
      await run("Quero pausar mesmo assim");
      expect(sentTexts().join(" ")).toContain("Para pausar, siga estes passos");
      expect(saved()).toBe(0);
    });

    it("pergunta de esclarecimento a uma pergunta do cliente não conta como insistência", async () => {
      const config = baseConfig({ themes: [PROBING_THEME as any], limits: { ...baseConfig().limits, maxStalledExchanges: 2 } } as any);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "agente", { stalledExchanges: 2 }), themeId: "t-dec" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Depende do plano. Qual é o seu?", theme: "t-dec" }));

      const result = await run("Como faço para pausar?");

      expect(result.handoff).toBe(false);
      expect(sentTexts().join(" ")).toContain("Qual é o seu?");
    });

    it("“chamo depois” em atendimento: resposta curta, sem fecho nem botões, e encerra", async () => {
      const config = baseConfig({ replyEnding: { info: { enabled: true, phrases: ["Posso te ajudar em mais alguma coisa?"], buttons: ["Não", "Preciso de ajuda"] } } } as Partial<V2AgentConfig>);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));

      const result = await run("Estou no trabalho, chamo depois");

      expect(result.closed).toBe(true);
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(sentTexts()).toEqual(["Combinado! Quando puder, é só me chamar por aqui. 😊"]);
      expect(mocks.resolveInline).toHaveBeenCalled();
    });

    it("aviso de transferência sai mesmo se um robô mandou o mesmo texto há pouco", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente"));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Explico: o valor muda pela data de pagamento.", handoff: true }));

      const result = await run("Quero falar com alguém sobre o valor");

      expect(result.handoff).toBe(true);
      const transfer = mocks.sendText.mock.calls.map((c) => c[0] as { text: string; bypassDuplicateGuard?: boolean }).find((a) => a.text.startsWith("Vou transferir"));
      expect(transfer?.bypassDuplicateGuard).toBe(true);
    });

    it("resposta repetida depois de o cliente dizer o que precisa: saída do assunto, não “Estou por aqui”", async () => {
      const config = baseConfig({ themes: [PROBING_THEME as any] } as any);
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
      mocks.getState.mockResolvedValue({ ...makeState("active", "agente"), themeId: "t-dec" });
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Me conta, por favor, o que você precisa resolver?", theme: "t-dec" }));
      mocks.sendText.mockResolvedValueOnce({ sent: false, reason: "near_duplicate" }).mockResolvedValue({ sent: true });

      const result = await run("Reativar o plano");

      expect(result.handoff).toBe(true);
      expect(sentTexts().join(" ")).not.toContain("Estou por aqui");
      expect(mocks.simpleHandoff).toHaveBeenCalledWith(expect.objectContaining({ destination: expect.objectContaining({ id: "dep-dec" }) }));
    });

    it("clique no botão de fecho encerra", async () => {
      mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: baseConfig(), active: true });
      mocks.getState.mockResolvedValue(makeState("active", "agente", { pendingOptions: ["Não, obrigado(a)!", "Preciso de ajuda"] }));
      mocks.callLLM.mockResolvedValue(llmOut({ reply: "Combinado! Até mais.", concluded: true }));

      const result = await run("Não, obrigado(a)!");

      expect(result.closed).toBe(true);
    });
  });

  it("resposta barrada por outro motivo não entra no log como enviada", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Resposta." }));
    mocks.sendText.mockResolvedValue({ sent: false, reason: "human_last_outbound" });
    await run("oi");
    const logged = mocks.logTurn.mock.lastCall![0] as { reply?: string };
    expect(logged.reply).toBeUndefined();
  });

  const THEME = {
    id: "t-acesso", name: "Acesso", when: ["primeiro acesso"], examples: [], instructions: "Explique como acessar.",
    allowedTools: [], allowedKnowledgeDocIds: [], allowedMessageModelIds: [], knowledgeDocIds: [], messageModelIds: [],
  };

  it("pedido na primeira mensagem: o assunto fica guardado na confirmação e vale depois do 'sim'", async () => {
    const config = baseConfig({ themes: [THEME] } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(null);
    await run("como faço meu primeiro acesso?");
    const upsert = mocks.upsertState.mock.calls.find((c) => c[0].stage === "confirming");
    expect(upsert?.[0].themeId).toBe("t-acesso");
    expect(mocks.logTurn.mock.lastCall![0].themeId).toBe("t-acesso");

    vi.clearAllMocks();
    mocks.resolveAgent.mockResolvedValue({ userId: "user-1", agentConfigId: "agent-1", wasAssigned: false });
    mocks.prismaConversationFindUnique.mockResolvedValue({ contactId: "contact-1", organizationId: "org-1", contact: { phone: "5511999999999" } });
    mocks.loadBridge.mockResolvedValue({ variables: {} });
    mocks.mapBridgeVars.mockReturnValue({});
    mocks.executeActions.mockResolvedValue({ results: [], anyHandoff: false, anyClose: false });
    mocks.sendText.mockResolvedValue({ sent: true });
    mocks.attendanceEnabled.mockResolvedValue(true);
    mocks.findInherited.mockResolvedValue(null);
    mocks.writeSummary.mockResolvedValue(null);
    mocks.loadPriorSummary.mockResolvedValue(null);
    mocks.appliedRules.mockResolvedValue(new Set());
    mocks.updateRunningSummary.mockResolvedValue(null);
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.loadContext.mockResolvedValue(CONTEXT_WITH_DEAL);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue({ ...makeState("confirming"), themeId: "t-acesso" });
    mocks.callLLM.mockResolvedValue(llmOut({ confirmed: true, reply: "Para acessar, siga os passos." }));
    await run("sim");
    expect(mocks.callLLM.mock.lastCall![0].themeId).toBe("t-acesso");
    expect(mocks.logTurn.mock.lastCall![0].themeId).toBe("t-acesso");
  });

  it("assunto indicado pelo modelo vale quando nada casou (igual à Conversa de teste)", async () => {
    const config = baseConfig({ themes: [THEME] } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ theme: "t-acesso" } as Partial<V2LLMOutput>));
    await run("não consigo entrar de jeito nenhum");
    expect(mocks.logTurn.mock.lastCall![0].themeId).toBe("t-acesso");
    const upsert = mocks.upsertState.mock.lastCall![0];
    expect(upsert.themeId).toBe("t-acesso");
  });

  it("atalho com palavra de pedir atendente registra 'cliente pediu pessoa'", async () => {
    const config = baseConfig({
      handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["atendente"] },
      rules: [{ id: "r1", name: "Pedido de pessoa", enabled: true, order: 0, conditions: [{ type: "keywords", values: ["atendente"] }], actions: [{ type: "handoff" }] }],
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    // Sem assunto, a primeira vez pergunta o que a pessoa precisa; a transferência (com a causa) é na seguinte.
    mocks.getState.mockResolvedValue(makeState("active", "agente", { humanRequestAsked: true }));
    const { takeV2Facts } = await import("../trace");
    let facts: Record<string, unknown> | undefined;
    mocks.logTurn.mockImplementation(async () => {
      facts = takeV2Facts();
    });
    await run("quero falar com um atendente");
    expect(facts?.handoffCause).toBe("human_request");
  });

  it("transferência por citar algo sem fonte usa a mensagem 'sem material' configurada", async () => {
    const config = baseConfig({ fallback: { noSource: { message: "Não tenho essa informação; vou chamar alguém da equipe." } } } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    const { noteV2Fact } = await import("../trace");
    mocks.callLLM.mockImplementation(async () => {
      noteV2Fact("handoffCause", "verification", { keepFirst: true });
      return llmOut({ handoff: true, reply: "Não tenho essa informação; vou chamar alguém da equipe.", reason: "Citava algo sem fonte" });
    });
    await run("qual o valor da taxa extra?");
    const texts = mocks.sendText.mock.calls.map((c) => c[0].text);
    expect(texts).toContain("Não tenho essa informação; vou chamar alguém da equipe.");
    expect(texts).not.toContain("Vou transferir.");
  });

  it("fecho configurado vai no fim da resposta; não vai quando transfere", async () => {
    const config = baseConfig({
      replyEnding: { procedure: { enabled: true, phrases: ["Me avisa se funcionou."] }, info: { enabled: false, phrases: [] } },
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Para acessar:\n1. Abra o app.\n2. Toque em Entrar." }));
    await run("como faço para acessar o aplicativo?");
    const texts = mocks.sendText.mock.calls.map((c) => c[0].text as string);
    expect(texts.at(-1)).toBe("Para acessar:\n1. Abra o app.\n2. Toque em Entrar.\n\nMe avisa se funcionou.");

    mocks.sendText.mockClear();
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "1. Abra.\n2. Entre.", handoff: true }));
    await run("não consegui entrar no aplicativo de jeito nenhum");
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).not.toContain("Me avisa se funcionou.");
  });

  it("cliente diz que não recebeu o anexo: reenvia só a mídia uma vez e diz a verdade; na segunda, chama a equipe", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.recentlySent.mockResolvedValue(new Set(["mm-1"]));
    const failed = { sendStatus: "failed", sendError: "Arquivo não encontrado no storage", messageType: "video", createdAt: new Date() };
    mocks.messageFindMany.mockImplementation(async (args: any) => (args?.where?.messageType?.in ? [failed] : []));
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Segue o vídeo de novo:", actions: [{ type: "send_message_model", modelId: "mm-1" }] as any }));
    mocks.executeActions.mockImplementation(async (actions: any[]) => ({ results: actions.map((a) => ({ action: a, ok: true, mediaSent: 1 })), anyHandoff: false, anyClose: false }));

    await run("Não veio o vídeo");

    const texts = mocks.sendText.mock.calls.map((c) => c[0].text as string);
    expect(texts[0]).toMatch(/não saiu da primeira vez/);
    expect(texts.join("|")).not.toContain("logo acima");
    const outbound = mocks.executeActions.mock.calls.flatMap((c) => c[0] as any[]).find((a) => a.type === "send_message_model");
    expect(outbound).toMatchObject({ modelId: "mm-1", mediaOnly: true });
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();

    // Segunda reclamação, duas falhas: não reenvia, explica e transfere.
    mocks.sendText.mockClear();
    mocks.executeActions.mockClear();
    mocks.messageFindMany.mockImplementation(async (args: any) => (args?.where?.messageType?.in ? [failed, failed] : []));
    const r2 = await run("Não recebi o vídeo");
    expect(r2.handoff).toBe(true);
    const texts2 = mocks.sendText.mock.calls.map((c) => c[0].text as string);
    expect(texts2[0]).toMatch(/Não estou conseguindo enviar o vídeo/);
    expect(mocks.executeActions.mock.calls.flatMap((c) => c[0] as any[]).some((a) => a.type === "send_message_model")).toBe(false);
    expect(mocks.simpleHandoff).toHaveBeenCalled();
  });

  it("pedido de pessoa: com pergunta responde primeiro; sem assunto pergunta uma vez e transfere na próxima", async () => {
    const config = baseConfig({
      handoff: { ...baseConfig().handoff, humanRequestKeywords: ["falar com atendente"] },
      rules: [{ id: "r-h", name: "Pedido de humano", order: 0, conditions: [{ type: "keywords", values: ["falar com atendente"] }], actions: [{ type: "handoff" }] }],
    } as unknown as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "A entrega leva dois dias úteis após a confirmação do pedido." }));

    const r1 = await run("quero falar com atendente, qual o prazo de entrega?");
    expect(r1.handoff).toBe(false);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.callLLM.mock.calls[0][0].humanRequestWithQuestion).toBe(true);
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();

    mocks.callLLM.mockClear();
    mocks.sendText.mockClear();
    const r2 = await run("quero falar com atendente");
    expect(r2.handoff).toBe(false);
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.sendText.mock.calls[0][0].text).toContain("me conta em uma frase o que você precisa");
    expect(mocks.upsertState.mock.calls.at(-1)![0].counters.humanRequestAsked).toBe(true);

    mocks.getState.mockResolvedValue(makeState("active", "agente", { humanRequestAsked: true }));
    const r3 = await run("quero falar com atendente");
    expect(r3.handoff).toBe(true);
    expect(mocks.simpleHandoff).toHaveBeenCalledTimes(1);
  });

  it("nova tentativa do turno depois de falha: se a anterior já respondeu, não responde de novo", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.messageFindMany.mockResolvedValue([{ createdAt: new Date("2026-01-01T10:00:00Z") }]);
    mocks.messageFindFirst.mockResolvedValue({ id: "out-1" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Outra resposta." }));

    const r = await run("qual o prazo de entrega?", { attempt: 1, messageIds: ["m-1"], turnId: "t-1" });

    expect(r.handoff).toBe(false);
    expect(mocks.callLLM).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.logTurn.mock.calls.at(-1)![0].discardedActions[0]).toMatchObject({ type: "no_reply" });
  });

  it("turno retomado por outro processo enquanto o modelo respondia: esta execução não envia", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    const claimedAt = new Date("2026-01-01T10:00:00Z");
    mocks.turnFindUnique.mockResolvedValue({ status: "READY", claimedAt: null });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "A entrega leva dois dias úteis." }));

    const r = await run("qual o prazo de entrega?", { turnId: "t-1", claimedAt });

    expect(r.error).toContain("retomado");
    expect(mocks.sendText).not.toHaveBeenCalled();
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();

    mocks.turnFindUnique.mockResolvedValue({ status: "PROCESSING", claimedAt });
    const ok = await run("qual o prazo de entrega?", { turnId: "t-1", claimedAt });
    expect(ok.error).toBeUndefined();
    expect(mocks.sendText).toHaveBeenCalled();
  });

  it("uma pessoa assumiu a conversa durante o turno: sem transferência, sem materiais, dono vira pessoa", async () => {
    const config = baseConfig({ allowedMessageModelIds: ["mm-1"] } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.sendText.mockResolvedValue({ sent: false, reason: "assignee_changed" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Vou te mandar o material:", actions: [{ type: "send_message_model", modelId: "mm-1" }] as any }));

    const r = await run("me manda o material");

    expect(r.sentReply).toBeUndefined();
    expect(mocks.executeActions.mock.calls.flatMap((c) => c[0] as any[]).some((a) => a.type === "send_message_model")).toBe(false);
    expect(mocks.upsertState.mock.calls.at(-1)![0].owner).toBe("pessoa");

    mocks.sendText.mockClear();
    mocks.simpleHandoff.mockClear();
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Esse caso precisa de análise da conta. Vou te transferir.", handoff: true }));
    const h = await run("quero falar com alguém");
    expect(h.handoff).toBe(true);
    expect(mocks.simpleHandoff).not.toHaveBeenCalled();
  });

  it("resposta vazia do modelo: pergunta ao cliente o que ele precisa em vez de ficar em silêncio", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.getState.mockResolvedValue(makeState("active"));
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "" }));

    const r = await run("hmm");

    expect(r.sentReply).toBe("Estou por aqui! Me conta o que você precisa que eu te ajudo.");
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
  });
});
