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
  attendanceEnabled: vi.fn(),
  messageFindMany: vi.fn(),
  findInherited: vi.fn(),
  resolveInline: vi.fn(),
  distributeNewInbound: vi.fn(),
  recentlySent: vi.fn(async (): Promise<Set<string>> => new Set()),
  pendingFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  messageFindFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  conversationUpdateMany: vi.fn(async () => ({ count: 1 })),
}));

vi.mock("../sent-materials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sent-materials")>()),
  recentlySentMessageModels: mocks.recentlySent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findUnique: mocks.prismaAIAgentFindUnique },
    conversation: { findUnique: mocks.prismaConversationFindUnique, updateMany: mocks.conversationUpdateMany },
    distributionPending: { findFirst: mocks.pendingFindFirst },
    message: { findMany: mocks.messageFindMany, findFirst: mocks.messageFindFirst },
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
    mocks.messageFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? [{ createdAt: new Date("2026-09-26T12:08:00Z") }] : [],
    );
    mocks.messageFindFirst.mockResolvedValueOnce({ id: "m-2" });
    mocks.callLLM.mockResolvedValue(llmOut({ reply: "Oi, Maria! Boa tarde 😊 Como posso ajudar você hoje?" }));
    await run("Oi, boa tarde!", { messageIds: ["m-1"] });
    expect(mocks.sendText).not.toHaveBeenCalled();

    // Sem mensagem nova, a saudação sai normalmente.
    mocks.messageFindFirst.mockResolvedValueOnce(null);
    await run("Oi, boa tarde!", { messageIds: ["m-1"] });
    expect(mocks.sendText.mock.calls.map((c) => c[0].text as string).join("|")).toContain("Como posso ajudar");
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
    mocks.messageFindFirst.mockResolvedValueOnce({ id: "m-2" });
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
        results: actions.map((a) => ({ action: a, ok: true, text: "Tutorial:\n1️⃣ Abra o app.\n2️⃣ Toque em Aulas." })),
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
});
