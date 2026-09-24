import { beforeEach, describe, expect, it, vi } from "vitest";

import { callV2LLM, buildV2ToolSet, knowledgePrefetchQuery } from "../llm";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import {
  searchV2Products,
  searchV2CrmRecords,
  searchV2Knowledge,
  listV2MessageModels,
} from "../tools";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

vi.mock("@/services/ai/provider", () => ({
  generateWithTools: vi.fn(),
}));

vi.mock("@/services/ai/agent-key", () => ({
  getAgentApiKey: vi.fn().mockResolvedValue("api-key"),
}));

vi.mock("@/services/ai/knowledge-docs", () => ({
  listKnowledgeDocs: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, perPage: 25 }),
  knowledgeDocTitlesByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("../tools", () => ({
  searchV2Products: vi.fn(),
  searchV2CrmRecords: vi.fn(),
  searchV2Knowledge: vi.fn(),
  listV2MessageModels: vi.fn(),
  describeV2MessageModels: vi.fn().mockResolvedValue([]),
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
    handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["humano"] },
    closure: {},
    limits: {},
    media: {},
    sentiment: {},
    survey: {},
    themes: [],
    rules: [],
    autonomyMode: "auto",
    enabledTools: ["search_products", "search_crm_records", "knowledge_search", "list_message_models"],
    ...overrides,
  } as unknown as V2AgentConfig;
}

function makeLLMResponse(text: string, toolCalls: Array<{ toolName: string; args: unknown; result: unknown }> = []) {
  return {
    text,
    inputTokens: 100,
    outputTokens: 50,
    toolCalls,
    steps: 1 + toolCalls.length,
  };
}

describe("callV2LLM function calling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passa tools de consulta para o modelo e devolve chamadas no trace", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "Encontrado", actions: [] }), [
        { toolName: "search_products", args: { query: "notebook" }, result: { total: 1 } },
      ]),
    );

    const config = baseConfig();
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "Quero um notebook",
      stage: "active",
    });

    expect(result.output.reply).toBe("Encontrado");
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].toolName).toBe("search_products");
    const passedTools = Object.keys((generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].tools);
    expect(passedTools).toContain("search_products");
  });

  it("apenas tools permitidas pelo tema aparecem", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );

    const config = baseConfig({
      themes: [
        {
          id: "vendas",
          name: "Vendas",
          instructions: "venda",
          when: [],
          examples: [],
          allowedTools: ["search_products"],
          allowedKnowledgeDocIds: [],
          allowedMessageModelIds: [],
          knowledgeDocIds: [],
          messageModelIds: [],
          productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [] },
        } as any,
      ],
    });

    await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "oi",
      stage: "active",
      themeId: "vendas",
    });

    const tools = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].tools;
    expect(Object.keys(tools)).toEqual(["search_products"]);
    expect(tools.search_crm_records).toBeUndefined();
  });

  it("renderiza variáveis aninhadas na resposta final do LLM", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "Olá @contact.name", actions: [] })),
    );

    const config = baseConfig();
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: { name: "Ana" }, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "oi",
      stage: "active",
    });

    expect(result.output.reply).toBe("Olá Ana");
  });

  it("aceita messageModel null e não gera ação", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", messageModel: null, actions: [] })),
    );
    const config = baseConfig();
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "oi",
      stage: "active",
    });
    expect(result.output.messageModel).toBeUndefined();
    expect(result.output.actions).toEqual([]);
  });

  it("converte messageModel válido em ação send_message_model", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(
        JSON.stringify({ reply: "ok", messageModel: { id: "m1", adapt: true, variables: { nome: "Ana" } }, actions: [] }),
      ),
    );
    const config = baseConfig();
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "oi",
      stage: "active",
    });
    expect(result.output.messageModel).toEqual({ id: "m1", adapt: true, variables: { nome: "Ana" } });
    expect(result.output.actions[0]).toMatchObject({ type: "send_message_model", modelId: "m1", variables: { nome: "Ana" } });
  });

  it("ignora messageModel.id inválido sem lançar erro de schema", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", messageModel: { id: { foo: "bar" } }, actions: [] })),
    );
    const config = baseConfig();
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "oi",
      stage: "active",
    });
    expect(result.output.messageModel).toBeUndefined();
    expect(result.output.actions).toEqual([]);
  });
});

describe("callV2LLM — pré-busca na base", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
  });

  const chunk = { docId: "doc-1", docTitle: "Como emitir o comprovante", content: "1. Abra a área do cliente\n2. Clique em Documentos", distance: 0.3 };

  it("busca pelo significado antes do LLM e põe os trechos no prompt e no trace", async () => {
    (searchV2Knowledge as ReturnType<typeof vi.fn>).mockResolvedValue({ query: "x", chunks: [chunk] });
    const config = baseConfig({ allowedKnowledgeDocIds: ["doc-1"] } as Partial<V2AgentConfig>);

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "minha empresa está pedindo um comprovante de vínculo",
      stage: "active",
    });

    expect(searchV2Knowledge).toHaveBeenCalledWith(expect.objectContaining({
      query: "minha empresa está pedindo um comprovante de vínculo",
      allowedDocIds: ["doc-1"],
    }));
    expect(result.systemPrompt).toContain("Trechos da base de conhecimento relacionados à mensagem");
    expect(result.systemPrompt).toContain("Como emitir o comprovante");
    expect(result.toolCalls[0]).toMatchObject({ toolName: "knowledge_search", args: { prefetch: true } });
  });

  it("sem materiais liberados não busca", async () => {
    const config = baseConfig({ allowedKnowledgeDocIds: [] } as Partial<V2AgentConfig>);

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "minha empresa está pedindo um comprovante de vínculo",
      stage: "active",
    });

    expect(searchV2Knowledge).not.toHaveBeenCalled();
    expect(result.systemPrompt).not.toContain("Trechos da base de conhecimento relacionados");
  });

  it("pré-busca vazia não entra no trace (não conta como 'consultou e não achou')", async () => {
    (searchV2Knowledge as ReturnType<typeof vi.fn>).mockResolvedValue({ query: "x", chunks: [] });
    const config = baseConfig({ allowedKnowledgeDocIds: ["doc-1"] } as Partial<V2AgentConfig>);

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "minha empresa está pedindo um comprovante de vínculo",
      stage: "active",
    });

    expect(result.toolCalls).toEqual([]);
  });
});

describe("callV2LLM — reformulação da busca", () => {
  const chunkA = { docId: "doc-a", docTitle: "Como emitir o comprovante", content: "passo a passo", distance: 0.35 };
  const chunkB = { docId: "doc-b", docTitle: "Outro assunto", content: "outra coisa", distance: 0.55 };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AI_V2_QUERY_REWRITE;
  });

  function mockModel(rewriteText: string) {
    (generateWithTools as ReturnType<typeof vi.fn>).mockImplementation(async (args: { tools?: unknown }) =>
      args.tools === undefined
        ? makeLLMResponse(rewriteText)
        : makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
  }

  async function run(config: V2AgentConfig) {
    return callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "minha empresa está pedindo uma comprovação de que sou cliente",
      stage: "active",
    });
  }

  it("busca com a mensagem e com as consultas reformuladas; fica o trecho mais próximo", async () => {
    mockModel('{"queries": ["como emitir comprovante"]}');
    (searchV2Knowledge as ReturnType<typeof vi.fn>).mockImplementation(async ({ query }: { query: string }) =>
      query === "como emitir comprovante" ? { query, chunks: [chunkA] } : { query, chunks: [chunkB] },
    );
    const config = baseConfig({ allowedKnowledgeDocIds: ["doc-a", "doc-b"] } as Partial<V2AgentConfig>);

    const result = await run(config);

    const queries = (searchV2Knowledge as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].query);
    expect(queries).toEqual([
      "minha empresa está pedindo uma comprovação de que sou cliente",
      "como emitir comprovante",
    ]);
    const prefetch = result.toolCalls[0] as { result: { chunks: Array<{ docId: string }> } };
    expect(prefetch.result.chunks.map((c) => c.docId)).toEqual(["doc-a", "doc-b"]);
  });

  it("a reformulação recebe os títulos dos materiais liberados", async () => {
    const { knowledgeDocTitlesByIds } = await import("@/services/ai/knowledge-docs");
    (knowledgeDocTitlesByIds as ReturnType<typeof vi.fn>).mockResolvedValue(["Como emitir o comprovante"]);
    mockModel('{"queries": []}');
    (searchV2Knowledge as ReturnType<typeof vi.fn>).mockResolvedValue({ query: "x", chunks: [] });
    const config = baseConfig({ allowedKnowledgeDocIds: ["doc-a"] } as Partial<V2AgentConfig>);

    await run(config);

    const rewriteCall = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0].tools === undefined);
    expect(rewriteCall?.[0].system).toContain("- Como emitir o comprovante");
  });

  it("falha na reformulação: busca segue só com a mensagem", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockImplementation(async (args: { tools?: unknown }) => {
      if (args.tools === undefined) throw new Error("timeout");
      return makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] }));
    });
    (searchV2Knowledge as ReturnType<typeof vi.fn>).mockResolvedValue({ query: "x", chunks: [chunkA] });
    const config = baseConfig({ allowedKnowledgeDocIds: ["doc-a"] } as Partial<V2AgentConfig>);

    const result = await run(config);

    expect(searchV2Knowledge).toHaveBeenCalledTimes(1);
    expect(result.output.reply).toBe("ok");
  });

  it("AI_V2_QUERY_REWRITE=0 desliga a reformulação", async () => {
    process.env.AI_V2_QUERY_REWRITE = "0";
    mockModel('{"queries": ["x"]}');
    (searchV2Knowledge as ReturnType<typeof vi.fn>).mockResolvedValue({ query: "x", chunks: [] });
    const config = baseConfig({ allowedKnowledgeDocIds: ["doc-a"] } as Partial<V2AgentConfig>);

    await run(config);

    expect((generateWithTools as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[0].tools !== undefined)).toBe(true);
    delete process.env.AI_V2_QUERY_REWRITE;
  });
});

describe("buildV2SystemPrompt — procedimentos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
  });

  it("pede passo a passo numerado completo (não resumir procedimento)", async () => {
    const config = baseConfig({ responseLength: "short" } as Partial<V2AgentConfig>);
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "como faço para incluir o item",
      stage: "active",
    });
    expect(result.systemPrompt).toContain("passo a passo numerado");
    expect(result.systemPrompt).toContain("com todos os passos do material, na ordem");
    expect(result.systemPrompt).not.toContain("sem enumerar");
    expect(result.systemPrompt).toContain("Um passo a passo completo não conta para esse limite");
  });
});

describe("buildV2SystemPrompt — mensagens prontas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
  });

  it("lista as mensagens prontas liberadas com o tipo de mídia", async () => {
    const { describeV2MessageModels } = await import("../tools");
    (describeV2MessageModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "mm-1", name: "Tutorial de acesso", mediaKinds: ["vídeo"] },
      { id: "mm-2", name: "Horários", mediaKinds: [] },
    ]);
    const config = baseConfig({ allowedMessageModelIds: ["mm-1", "mm-2"] } as Partial<V2AgentConfig>);

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "como faço o acesso",
      stage: "active",
    });

    expect(describeV2MessageModels).toHaveBeenCalledWith(["mm-1", "mm-2"]);
    expect(result.systemPrompt).toContain("# Mensagens prontas que você pode enviar");
    expect(result.systemPrompt).toContain("- mm-1: Tutorial de acesso (inclui vídeo)");
    expect(result.systemPrompt).toContain("- mm-2: Horários");
  });
});

describe("knowledgePrefetchQuery", () => {
  it("acompanhamento curto leva junto a pergunta anterior do cliente", () => {
    expect(knowledgePrefetchQuery("consegue me enviar?", [
      { role: "user", content: "preciso de um comprovante de vínculo" },
      { role: "assistant", content: "Claro." },
    ])).toBe("preciso de um comprovante de vínculo\nconsegue me enviar?");
  });

  it("mensagem com conteúdo vai sozinha", () => {
    expect(knowledgePrefetchQuery("preciso de um comprovante de vínculo", [
      { role: "user", content: "outra coisa antiga" },
    ])).toBe("preciso de um comprovante de vínculo");
  });
});

describe("callV2LLM — saída inválida", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("JSON quebrado não vira mensagem para o cliente: aplica o fallback com handoff", async () => {
    // Resposta cortada + normalizador também sem JSON válido.
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse('{"reply": "Olá, sua assinatura está'),
    );
    const config = baseConfig();

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "Oi",
      stage: "active",
    });

    expect(result.output.handoff).toBe(true);
    expect(result.output.reply).not.toContain('"reply"');
  });

  it("texto livre de verdade continua sendo usado como resposta", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse("Olá! Sua assinatura está ativa."),
    );
    const config = baseConfig();

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "Oi",
      stage: "active",
    });

    expect(result.output.handoff).toBe(false);
    expect(result.output.reply).toBe("Olá! Sua assinatura está ativa.");
  });

  it("o exemplo de saída do prompt não sugere handoff", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
    const config = baseConfig();

    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "Oi",
      stage: "active",
    });

    expect(result.systemPrompt).not.toMatch(/"actions":\s*\[\s*\{\s*"type":\s*"handoff"/);
  });
});

describe("buildV2ToolSet governor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (searchV2Products as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 0, products: [] });
  });

  it("limita chamadas da mesma ferramenta por turno", async () => {
    const { tools, governor } = buildV2ToolSet({
      config: baseConfig({ toolGovernor: { maxCallsPerTurn: 2, maxRepeatsPerTool: 10 } }),
      context: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
      agentId: "agent-1",
      apiKey: "key",
    });

    await (tools.search_products!.execute as any)({ query: "a" }, {} as any);
    await (tools.search_products!.execute as any)({ query: "b" }, {} as any);
    await (tools.search_products!.execute as any)({ query: "c" }, {} as any);

    expect(governor.stats().totalCalls).toBe(2);
    expect(governor.stats().limitHit).toBe(true);
  });

  it("disponibiliza knowledge_search mesmo sem tema quando há materiais permitidos", async () => {
    const config = baseConfig({
      enabledTools: [],
      allowedKnowledgeDocIds: ["doc-1"],
    });
    const { tools } = buildV2ToolSet({
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      agentId: "agent-1",
      apiKey: "key",
    });
    expect(Object.keys(tools)).toContain("knowledge_search");
  });

  it("lista knowledge_search no system prompt quando há materiais permitidos sem tema", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
    const config = baseConfig({
      enabledTools: [],
      allowedKnowledgeDocIds: ["doc-1"],
    });
    await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "quero cancelar",
      stage: "active",
    });
    // A última chamada é a resposta; antes dela pode vir a reformulação da busca.
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].system as string;
    expect(system).toContain("knowledge_search");
    expect(system).toContain("Há materiais de consulta disponíveis");
  });
});

describe("buildV2SystemPrompt — Tom, tamanho e regras", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );
  });

  it("modo JSON: desligado por padrão e ligado pela configuração do agente", async () => {
    const ctx = { contact: null, deals: [], selectedDeal: null, fields: baseConfig().contextFields };
    await callV2LLM({ agentId: "agent-1", config: baseConfig(), context: ctx, userMessage: "oi", stage: "active" });
    expect((generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].jsonMode).toBe(false);

    vi.clearAllMocks();
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })));
    await callV2LLM({ agentId: "agent-1", config: baseConfig({ structuredOutput: true }), context: ctx, userMessage: "oi", stage: "active" });
    expect((generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].jsonMode).toBe(true);
  });

  it("nome entre aspas fora do material: pede reescrita e usa a versão corrigida", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeLLMResponse(JSON.stringify({ reply: 'Vá em "Fale Conosco".', actions: [] })))
      .mockResolvedValueOnce(makeLLMResponse(JSON.stringify({ reply: "Não tenho esse caminho no material.", handoff: true, actions: [] })));
    const r = await callV2LLM({
      agentId: "agent-1",
      config: baseConfig(),
      context: { contact: null, deals: [], selectedDeal: null, fields: baseConfig().contextFields },
      userMessage: "como falo com a coordenação?",
      stage: "active",
    });
    const calls = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].system).toContain('"Fale Conosco"');
    expect(r.output.reply).toBe("Não tenho esse caminho no material.");
    expect(r.output.handoff).toBe(true);
  });

  it("reescrita que continua inventando vira transferência", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: 'Clique em "Menu Secreto".', actions: [] })),
    );
    const r = await callV2LLM({
      agentId: "agent-1",
      config: baseConfig(),
      context: { contact: null, deals: [], selectedDeal: null, fields: baseConfig().contextFields },
      userMessage: "onde clico?",
      stage: "active",
    });
    expect(r.output.handoff).toBe(true);
    expect(r.output.reply).toBe("Vou transferir.");
    expect(r.output.reason).toContain("Menu Secreto");
  });

  it("nome entre aspas que veio da conversa não é invenção", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: 'Entendi, a opção "Relatório anual" não aparece para você.', actions: [] })),
    );
    await callV2LLM({
      agentId: "agent-1",
      config: baseConfig(),
      context: { contact: null, deals: [], selectedDeal: null, fields: baseConfig().contextFields },
      userMessage: "a opção relatório anual não aparece",
      stage: "active",
    });
    expect((generateWithTools as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("campo fora do formato não derruba a resposta nem transfere", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(
        JSON.stringify({
          reply: "Oi! Como posso ajudar?",
          sentiment: "positive",
          confirmed: "talvez",
          collected: { nome: null, idade: 30, obs: "ok", lista: ["a"] },
          actions: [{ type: "nenhuma" }, { type: "add_tag", tag: "x" }],
          theme: 42,
        }),
      ),
    );
    const r = await callV2LLM({
      agentId: "agent-1",
      config: baseConfig({ structuredOutput: true }),
      context: { contact: null, deals: [], selectedDeal: null, fields: baseConfig().contextFields },
      userMessage: "oie",
      stage: "active",
    });
    expect(r.output.reply).toBe("Oi! Como posso ajudar?");
    expect(r.output.handoff).toBe(false);
    expect(r.output.sentiment).toBe("neutral");
    expect(r.output.confirmed).toBeNull();
    expect(r.output.collected).toEqual({ idade: "30", obs: "ok" });
    expect(r.output.actions).toEqual([{ type: "add_tag", tag: "x" }]);
    expect(r.output.theme).toBeUndefined();
  });

  it("modo JSON recusado pelo modelo (400): repete sem ele e responde", async () => {
    const refused = Object.assign(new Error("response_format not supported"), { statusCode: 400 });
    (generateWithTools as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce(makeLLMResponse(JSON.stringify({ reply: "Olá!", actions: [] })));
    const r = await callV2LLM({
      agentId: "agent-1",
      config: baseConfig({ structuredOutput: true }),
      context: { contact: null, deals: [], selectedDeal: null, fields: baseConfig().contextFields },
      userMessage: "oi",
      stage: "active",
    });
    const calls = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].jsonMode).toBe(true);
    expect(calls[1][0].jsonMode).toBe(false);
    expect(r.output.reply).toBe("Olá!");
  });

  it("inclui o guia de escrita natural em qualquer tamanho", async () => {
    const config = baseConfig({ responseLength: "short" });
    await callV2LLM({ agentId: "agent-1", config, context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields }, userMessage: "oi", stage: "active" });
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    expect(system).toContain("# Como escrever");
    expect(system).toContain("recomece do primeiro passo");
  });

  it("muda o tom no texto montado para o modelo", async () => {
    const config = baseConfig({ tone: "Formal e respeitoso" });
    await callV2LLM({ agentId: "agent-1", config, context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields }, userMessage: "oi", stage: "active" });
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    expect(system).toContain("# Tom de voz\nFormal e respeitoso");
  });

  it("cada tamanho gera o limite de saída esperado", async () => {
    const cases: Array<[NonNullable<V2AgentConfig["responseLength"]>, number, string]> = [
      ["short", 600, "enxutas"],
      ["medium", 1000, "equilibrada"],
      ["long", 2000, "mais detalhes"],
    ];
    for (const [length, tokens, instruction] of cases) {
      vi.clearAllMocks();
      (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
      );
      const config = baseConfig({ responseLength: length });
      await callV2LLM({ agentId: "agent-1", config, context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields }, userMessage: "oi", stage: "active" });
      const args = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.maxOutputTokens).toBe(tokens);
      expect(args.system).toContain(instruction);
    }
  });

  it("repete a chamada com mais tokens quando a resposta é cortada por length", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        text: "{\"reply\": \"incomplete",
        inputTokens: 100,
        outputTokens: 50,
        finishReason: "length",
        toolCalls: [],
        steps: 1,
      })
      .mockResolvedValueOnce(
        makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
      );

    const config = baseConfig({ responseLength: "short" });
    const result = await callV2LLM({ agentId: "agent-1", config, context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields }, userMessage: "oi", stage: "active" });

    expect(result.wasExpanded).toBe(true);
    expect(result.output.reply).toBe("ok");
    const calls = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].maxOutputTokens).toBe(600);
    expect(calls[1][0].maxOutputTokens).toBe(2000);
  });

  it("campo só com 'ler' não aparece na seção citável do prompt", async () => {
    const config = baseConfig();
    const context = {
      contact: { Nome: "João", Telefone: "11999999999" },
      citableContact: { Nome: "João" },
      deals: [],
      selectedDeal: { Etapa: "Negociação", Valor: "R$ 1.000" },
      citableDeal: { Etapa: "Negociação" },
      fields: config.contextFields,
    };
    await callV2LLM({ agentId: "agent-1", config, context: context as any, userMessage: "oi", stage: "active" });
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    expect(system).toContain("# Dados do cliente para consulta interna");
    expect(system).toContain("# Dados que você pode citar na resposta");
    expect(system).toContain("Telefone");
    expect(system).toContain("Valor");
    expect(system).toContain("Regra de citação: só escreva/repita");
  });

  it("cliente não encontrado é declarado no prompt sem erro", async () => {
    const config = baseConfig();
    const context = { contact: null, deals: [], selectedDeal: null, fields: config.contextFields };
    await callV2LLM({ agentId: "agent-1", config, context, userMessage: "oi", stage: "active" });
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    expect(system).toContain("Nenhum contato encontrado para esta conversa.");
    expect(system).not.toContain("undefined");
  });

  it("substitui variáveis de informações fixas (@Nome) na resposta final", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "Olá, aqui é @Nome da empresa." })),
    );

    const config = baseConfig({ variables: [{ key: "Nome da empresa", value: "Empresa Exemplo" }] });
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "oi",
      stage: "active",
    });

    expect(result.output.reply).toBe("Olá, aqui é Empresa Exemplo.");
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    expect(system).toContain("Nome da empresa: Empresa Exemplo");
  });

  it("com vários negócios e modo ask, o prompt lista os negócios e pede para perguntar", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLLMResponse(JSON.stringify({ reply: "ok", actions: [] })),
    );

    const config = baseConfig({ dealSelection: "ask" });
    const context = {
      contact: { Nome: "João" },
      deals: [
        { id: "d1", title: "Negócio A", stageName: "Proposta" },
        { id: "d2", title: "Negócio B", stageName: "Negociação" },
      ],
      selectedDeal: null,
      fields: config.contextFields,
    };
    await callV2LLM({ agentId: "agent-1", config, context: context as any, userMessage: "oi", stage: "active" });
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    expect(system).toContain("# Negócios abertos do cliente");
    expect(system).toContain("1. Negócio A (Proposta)");
    expect(system).toContain("2. Negócio B (Negociação)");
    expect(system).toContain("Pergunte ao cliente qual destes negócios");
  });

  it("envia todas as regras globais na ordem cadastrada", async () => {
    const rules = ["Nunca informe prazos.", "Sempre peça confirmação.", "Não invente preço."];
    const config = baseConfig({ globalRules: rules });
    await callV2LLM({ agentId: "agent-1", config, context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields }, userMessage: "oi", stage: "active" });
    const system = (generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].system as string;
    const idx = system.indexOf("# Regras globais");
    expect(idx).toBeGreaterThan(-1);
    const block = system.slice(idx);
    expect(block.indexOf("Nunca informe prazos.")).toBeLessThan(block.indexOf("Sempre peça confirmação."));
    expect(block.indexOf("Sempre peça confirmação.")).toBeLessThan(block.indexOf("Não invente preço."));
  });
});

describe("callV2LLM — dados sensíveis", () => {
  beforeEach(() => vi.clearAllMocks());

  it("modelo recebe marcador; ferramenta e variável recebem o valor; resposta sai mascarada; senha some", async () => {
    (searchV2Products as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 0, products: [] });
    (generateWithTools as ReturnType<typeof vi.fn>).mockImplementation(async (req: any) => {
      const sent = JSON.stringify(req.messages);
      expect(sent).toContain("[CPF 1]");
      expect(sent).not.toContain("529.982.247-25");
      expect(sent).not.toContain("Abc@1234");
      await req.tools.search_products.execute({ query: "[CPF 1]" }, {} as any);
      return makeLLMResponse(JSON.stringify({ reply: "Achei o CPF [CPF 1].", collected: { cpf: "[CPF 1]" }, actions: [] }));
    });

    const config = baseConfig();
    const result = await callV2LLM({
      agentId: "agent-1",
      config,
      context: { contact: null, deals: [], selectedDeal: null, fields: config.contextFields },
      userMessage: "meu cpf é 529.982.247-25 e a senha: Abc@1234",
      previousMessages: [{ role: "user", content: "oi, 529.982.247-25" }],
      stage: "active",
    });

    expect((searchV2Products as ReturnType<typeof vi.fn>).mock.calls[0][0].query).toBe("529.982.247-25");
    expect(result.output.collected.cpf).toBe("529.982.247-25");
    expect(result.output.reply).toBe("Achei o CPF ***25.");
  });
});

describe("mergeChunks — resultado das consultas da pré-busca", () => {
  const c = (docId: string, content: string, distance: number) => ({ docId, docTitle: docId, content, distance });
  it("o melhor trecho de cada consulta entra, mesmo com distância pior que o de outra", async () => {
    const { mergeChunks } = await import("../llm");
    const generic = [c("como-acessar", "a", 0.24), c("como-acessar", "b", 0.25), c("outro", "c", 0.26), c("outro", "d", 0.27)];
    const specific = [c("calendario", "datas AF", 0.34)];
    const r = mergeChunks([generic, specific], 3);
    expect(r.map((x) => x.content)).toContain("datas AF");
    expect(r).toHaveLength(3);
    expect(r[0].content).toBe("a");
  });
});

describe("currentDateLine", () => {
  it("dá a data e a hora no fuso do agente", async () => {
    const { currentDateLine } = await import("../llm");
    const line = currentDateLine("America/Sao_Paulo", new Date("2026-09-24T20:02:00Z"));
    expect(line).toContain("24/09/2026");
    expect(line).toContain("17:02");
    expect(line).toContain("quinta-feira");
  });
  it("fuso inválido não derruba o prompt", async () => {
    const { currentDateLine } = await import("../llm");
    expect(currentDateLine("Fuso/Invalido", new Date("2026-09-24T20:02:00Z"))).toContain("2026-09-24");
  });
});

describe("mediaUnderstandingNote", () => {
  it("só aparece quando a mensagem veio de mídia; confirma se ligado", async () => {
    const { mediaUnderstandingNote } = await import("../llm");
    const on = { media: { confirmUnderstanding: true } } as unknown as V2AgentConfig;
    const off = { media: { confirmUnderstanding: false } } as unknown as V2AgentConfig;
    expect(mediaUnderstandingNote(on, "quero cancelar")).toBe("");
    expect(mediaUnderstandingNote(on, "[Áudio do cliente, transcrito]: quero cancelar")).toContain("confirme em uma frase");
    const n = mediaUnderstandingNote(off, "[Imagem enviada pelo cliente]: tela de erro");
    expect(n).toContain("# Mídia do cliente");
    expect(n).not.toContain("confirme");
  });
});
