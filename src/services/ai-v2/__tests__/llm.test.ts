import { beforeEach, describe, expect, it, vi } from "vitest";

import { callV2LLM, buildV2ToolSet } from "../llm";
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

vi.mock("../tools", () => ({
  searchV2Products: vi.fn(),
  searchV2CrmRecords: vi.fn(),
  searchV2Knowledge: vi.fn(),
  listV2MessageModels: vi.fn(),
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
    autonomyMode: "autonomous",
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
});
