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
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aIAgentConfig: { findUnique: mocks.prismaAIAgentFindUnique },
    conversation: { findUnique: mocks.prismaConversationFindUnique },
    message: { findMany: mocks.messageFindMany },
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
    mocks.sendText.mockResolvedValue(undefined);
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

    const { processV2Turn } = await import("../engine");
    await processV2Turn({
      conversationId: "conv-1",
      channel: "meta",
      userMessage: "Oi",
    });

    expect(mocks.callLLM).not.toHaveBeenCalled();
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
    mocks.sendText.mockResolvedValue(undefined);
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

  it("handoff pedido como AÇÃO: avisa o cliente antes e transfere uma vez só", async () => {
    const config = baseConfig();
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.callLLM.mockResolvedValue(llmOut({ actions: [{ type: "handoff" }] as any }));
    const order: string[] = [];
    mocks.sendText.mockImplementation(async () => { order.push("send"); });
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

  it("identificação: 2ª tentativa com outro texto e depois transfere", async () => {
    const config = baseConfig({ entry: { confirmContact: false, onDealNotFound: "ask_identification", maxAttempts: 2 } } as Partial<V2AgentConfig>);
    mocks.prismaAIAgentFindUnique.mockResolvedValue({ id: "agent-1", simpleConfig: config, active: true });
    mocks.loadContext.mockResolvedValue({ contact: { Nome: "João" }, contactRaw: { id: "contact-1" }, deals: [], selectedDeal: null, dealId: undefined });

    // 1º turno: pergunta.
    mocks.getState.mockResolvedValue(null);
    await run("Oi");
    const first = mocks.sendText.mock.calls.at(-1)![0].text as string;
    expect(mocks.upsertState.mock.calls.at(-1)![0]).toMatchObject({ stage: "identifying", identificationAttempts: 1 });

    // 2º turno: cliente respondeu, ainda sem negócio → pergunta diferente.
    mocks.getState.mockResolvedValue({ ...makeState("identifying"), identificationAttempts: 1 });
    await run("123.456.789-00");
    const second = mocks.sendText.mock.calls.at(-1)![0].text as string;
    expect(second).not.toBe(first);
    expect(mocks.upsertState.mock.calls.at(-1)![0]).toMatchObject({ stage: "identifying", identificationAttempts: 2 });

    // 3º turno: esgotou → transfere, sem chamar o LLM.
    mocks.getState.mockResolvedValue({ ...makeState("identifying"), identificationAttempts: 2 });
    const result = await run("ana@x.com");
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
});

