import { describe, it, expect, vi, beforeEach } from "vitest";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  tryGetAgentApiKey: vi.fn(),
  callV2LLMTest: vi.fn(),
  loadV2Context: vi.fn(),
  buildAskDealMessage: vi.fn(),
}));

vi.mock("@/services/ai/agent-key", () => ({
  tryGetAgentApiKey: mocks.tryGetAgentApiKey,
}));

vi.mock("../llm", () => ({
  callV2LLMTest: mocks.callV2LLMTest,
}));

vi.mock("../context", () => ({
  loadV2Context: mocks.loadV2Context,
  buildAskDealMessage: mocks.buildAskDealMessage,
}));

function baseConfig(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
  return {
    name: "Agente de teste",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: [],
    allowedDomains: [],
    contextFields: { contact: [], deal: [] },
    variables: [],
    entry: { confirmContact: false, onDealNotFound: "handoff" },
    handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["humano"] },
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

describe("simulateV2Turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadV2Context.mockResolvedValue({
      contact: null,
      citableContact: null,
      deals: [],
      selectedDeal: null,
      citableDeal: null,
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Nenhum negócio carregado.",
    });
  });

  it("lança NO_OPENAI_KEY quando não há chave configurada (parte B, item 2)", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue(null);
    const { simulateV2Turn } = await import("../test-turn");
    await expect(simulateV2Turn("agent-1", baseConfig(), "oi")).rejects.toThrow("NO_OPENAI_KEY");
  });

  it("retorna resultado quando há chave configurada", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.callV2LLMTest.mockResolvedValue({
      output: {
        reply: "Olá!",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Saudação",
        actions: [],
      },
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [],
      systemPrompt: "# Tom de voz\nObjetivo",
    });
    const cfg = baseConfig();
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "oi");
    expect(result.reply).toBe("Olá!");
    expect(result.crmContext.contact).toBeNull();
  });

  it("carrega contexto do contato real quando contactId é informado", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({
      contact: { Nome: "Marcelo", Telefone: "+5511999999999" },
      citableContact: { Nome: "Marcelo" },
      deals: [],
      selectedDeal: null,
      citableDeal: null,
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Nenhum negócio carregado.",
    });
    mocks.callV2LLMTest.mockResolvedValue({
      output: {
        reply: "Olá Marcelo!",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Saudação",
        actions: [],
      },
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [],
      systemPrompt: "# Tom de voz\nObjetivo",
    });
    const cfg = baseConfig();
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "oi", [], "org-1", "contact-marcelo");
    expect(mocks.loadV2Context).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", contactId: "contact-marcelo" }),
    );
    expect(result.crmContext.contact).toMatchObject({ Nome: "Marcelo" });
  });

  it("aplica mensagem de 'sem material' quando busca volta vazia e não há dados do cliente", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.callV2LLMTest.mockResolvedValue({
      output: {
        reply: "Acho que é isso.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Tentativa",
        actions: [],
      },
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 100,
      toolCalls: [{ toolName: "knowledge_search", args: { query: "x" }, result: { chunks: [] } }],
      systemPrompt: "# Tom de voz\nObjetivo",
    });
    const cfg = baseConfig({
      fallback: { noSource: { message: "Não encontrei isso nos materiais; um consultor vai te ajudar." } } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "Como funciona x?");
    expect(result.handoff).toBe(false);
    expect(result.reply).toBe("Não encontrei isso nos materiais; um consultor vai te ajudar.");
    expect(result.reason).toContain("sem resultados");
  });

  it("na primeira mensagem, envia boas-vindas + confirmação sem chamar o modelo", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({
      contact: { Nome: "Marcelo" },
      citableContact: { Nome: "Marcelo" },
      deals: [],
      selectedDeal: { id: "d1", Título: "Matrícula" },
      citableDeal: { Título: "Matrícula" },
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Negócio mais recente selecionado automaticamente.",
    });
    const cfg = baseConfig({
      entry: {
        openingEnabled: true,
        openingMessage: "Olá! Sou seu assistente virtual.",
        confirmContact: true,
        confirmationMessage: "Encontrei você na nossa base! Posso ajudar?",
        onDealNotFound: "ask_identification",
      } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "Oi", [], "org-1", "contact-marcelo");
    expect(result.reply).toContain("Olá! Sou seu assistente virtual.");
    expect(result.reply).toContain("Encontrei você na nossa base! Posso ajudar?");
    expect(result.reason).toContain("fluxo de entrada");
    expect(mocks.callV2LLMTest).not.toHaveBeenCalled();
  });

  it("na primeira mensagem sem negócio, envia boas-vindas + pedido de identificação", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({
      contact: { Nome: "Marcelo" },
      citableContact: { Nome: "Marcelo" },
      deals: [],
      selectedDeal: null,
      citableDeal: null,
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Nenhum negócio aberto encontrado.",
    });
    const cfg = baseConfig({
      entry: {
        openingEnabled: true,
        openingMessage: "Olá! Sou seu assistente virtual.",
        confirmContact: true,
        onDealNotFound: "ask_identification",
        identificationMessage: "Me confirme seu e-mail para prosseguir.",
      } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "Oi", [], "org-1", "contact-marcelo");
    expect(result.reply).toContain("Olá! Sou seu assistente virtual.");
    expect(result.reply).toContain("Me confirme seu e-mail para prosseguir.");
  });

  it("consulta materiais sobre cancelamento e retorna resposta com trechos usados", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({
      contact: { Nome: "Marcelo" },
      citableContact: { Nome: "Marcelo" },
      deals: [],
      selectedDeal: null,
      citableDeal: null,
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Nenhum negócio aberto encontrado.",
    });
    mocks.callV2LLMTest.mockResolvedValue({
      output: {
        reply: "Para cancelar, envie um e-mail para cancelamentos@empresa.com com seu CPF.",
        confirmed: null,
        handoff: false,
        concluded: false,
        outOfScope: false,
        sentiment: "neutral",
        collected: {},
        reason: "Resposta encontrada nos materiais.",
        actions: [],
      },
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 200,
      toolCalls: [
        {
          toolName: "knowledge_search",
          args: { query: "cancelar" },
          result: {
            chunks: [
              { docId: "doc-1", docTitle: "Cancelamento", content: "Para cancelar, envie um e-mail para cancelamentos@empresa.com", distance: 0.1 },
            ],
          },
        },
      ],
      systemPrompt: "# Tom de voz\nObjetivo",
    });
    const cfg = baseConfig({
      allowedKnowledgeDocIds: ["doc-1"],
      entry: { openingEnabled: false, confirmContact: false, onDealNotFound: "handoff" } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "quero cancelar");
    expect(result.reply).toContain("cancelamentos@empresa.com");
    expect(result.ragChunks.length).toBe(1);
    expect(result.ragChunks[0].docTitle).toBe("Cancelamento");
    expect(result.toolCalls[0].toolName).toBe("knowledge_search");
  });
});
