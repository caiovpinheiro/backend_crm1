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

// Sem rede: embedding falha e a escolha de assunto cai em gatilho/atual.
vi.mock("@/services/ai/provider", () => ({
  embedTexts: vi.fn().mockRejectedValue(new Error("sem rede no teste")),
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
      selectedDeal: { id: "d1", Título: "Contrato" },
      citableDeal: { Título: "Contrato" },
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

  it("separate_turn: primeiro turno só boas-vindas e stage confirming", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({
      contact: { name: "Marcelo" },
      citableContact: { name: "Marcelo" },
      deals: [{ id: "d1", title: "Contrato" }],
      selectedDeal: { id: "d1", title: "Contrato" },
      citableDeal: { title: "Contrato" },
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Negócio mais recente.",
    });
    const cfg = baseConfig({
      entry: {
        openingEnabled: true,
        openingMessage: "Oi @name! Sou a consultora virtual.",
        confirmContact: true,
        confirmationMode: "separate_turn",
        confirmationMessage: "Confirmo que estou falando com você. Como posso ajudar?",
        onDealNotFound: "ask_identification",
      } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn("agent-1", cfg, "Oi", [], "org-1", "contact-marcelo");
    expect(result.reply).toBe("Oi Marcelo! Sou a consultora virtual.");

    expect(result.stage).toBe("confirming");
    expect(mocks.callV2LLMTest).not.toHaveBeenCalled();
  });

  it("separate_turn: segundo turno envia confirmação sem chamar LLM", async () => {
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({
      contact: { name: "Marcelo" },
      citableContact: { name: "Marcelo" },
      deals: [{ id: "d1", title: "Contrato" }],
      selectedDeal: { id: "d1", title: "Contrato" },
      citableDeal: { title: "Contrato" },
      fields: { contact: [], deal: [] },
      exposure: { readableKeys: [], citableKeys: [], orgWide: false },
      dealSelectionReason: "Negócio mais recente.",
    });
    const cfg = baseConfig({
      entry: {
        openingEnabled: true,
        openingMessage: "Oi @name!",
        confirmContact: true,
        confirmationMode: "separate_turn",
        confirmationMessage: "@name, confirmo que estou falando com você. Como posso ajudar?",
        onDealNotFound: "ask_identification",
      } as any,
    });
    const { simulateV2Turn } = await import("../test-turn");
    const result = await simulateV2Turn(
      "agent-1",
      cfg,
      "sim",
      [
        { role: "user", content: "Oi" },
        { role: "assistant", content: "Oi Marcelo!" },
      ],
      "org-1",
      "contact-marcelo",
      undefined,
      "confirming",
    );
    expect(result.reply).toBe("Marcelo, confirmo que estou falando com você. Como posso ajudar?");
    expect(result.stage).toBe("confirming");
    expect(mocks.callV2LLMTest).not.toHaveBeenCalled();
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

describe("simulateV2Turn — igual à produção", () => {
  const llm = (over: Record<string, unknown> = {}) => ({
    output: { reply: "Resposta do modelo.", confirmed: null, handoff: false, concluded: false, outOfScope: false, sentiment: "neutral", collected: {}, reason: "ok", actions: [], ...over },
    inputTokens: 1, outputTokens: 1, latencyMs: 1, toolCalls: [], systemPrompt: "",
  });
  const history = [{ role: "user" as const, content: "oi" }, { role: "assistant" as const, content: "Olá!" }];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryGetAgentApiKey.mockResolvedValue("sk-test");
    mocks.loadV2Context.mockResolvedValue({ contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } });
  });

  it("regra com ação terminal responde sem chamar o modelo", async () => {
    const cfg = baseConfig({ rules: [{ id: "r", name: "Fixa", order: 0, conditions: [{ type: "keywords", values: ["horário"] }], actions: [{ type: "send_message", message: "Atendemos das 8h às 18h." }] }] } as never);
    const { simulateV2Turn } = await import("../test-turn");
    const r = await simulateV2Turn("agent-1", cfg, "qual o horário?", history);
    expect(mocks.callV2LLMTest).not.toHaveBeenCalled();
    expect(r.reply).toBe("Atendemos das 8h às 18h.");
  });

  it("regra com mensagem vazia segue para o modelo", async () => {
    mocks.callV2LLMTest.mockResolvedValue(llm());
    const cfg = baseConfig({ rules: [{ id: "r", name: "Vazia", order: 0, conditions: [{ type: "keywords", values: ["horário"] }], actions: [{ type: "send_message", message: "" }] }] } as never);
    const { simulateV2Turn } = await import("../test-turn");
    const r = await simulateV2Turn("agent-1", cfg, "qual o horário?", history);
    expect(r.reply).toBe("Resposta do modelo.");
  });

  it("ao transferir mostra a mensagem de transferência, como o cliente receberia", async () => {
    mocks.callV2LLMTest.mockResolvedValue(llm({ handoff: true, reply: "Texto que não seria enviado." }));
    const { simulateV2Turn } = await import("../test-turn");
    const r = await simulateV2Turn("agent-1", baseConfig(), "quero falar com alguém", history);
    expect(r.handoff).toBe(true);
    expect(r.reply).toBe("Vou transferir.");
  });

  it("assunto criado sem lista de ações não bloqueia as ações liberadas no agente", async () => {
    mocks.callV2LLMTest.mockResolvedValue(llm({ reply: "Qual opção?", actions: [{ type: "ask_with_options", options: ["Boleto", "Cartão"] }] }));
    const cfg = baseConfig({
      enabledTools: ["ask_with_options"],
      themes: [{ id: "pag", name: "Pagamento", when: ["pagamento"], examples: [], instructions: "", allowedTools: [] }],
    } as never);
    const { simulateV2Turn } = await import("../test-turn");
    const r = await simulateV2Turn("agent-1", cfg, "dúvida sobre pagamento", history);
    expect(r.discardedActions).toHaveLength(0);
    expect(r.reply).toBe(["Qual opção?", "1. Boleto\n2. Cartão"].join("\n\n"));
  });

  it("mantém o assunto da mensagem anterior", async () => {
    mocks.callV2LLMTest.mockResolvedValue(llm());
    const cfg = baseConfig({ themes: [{ id: "pag", name: "Pagamento", when: ["pagamento"], examples: [], instructions: "", allowedTools: [] }] } as never);
    const { simulateV2Turn } = await import("../test-turn");
    const r = await simulateV2Turn("agent-1", cfg, "e agora?", history, undefined, undefined, undefined, "active", "pag");
    expect(r.themeId).toBe("pag");
  });
});
