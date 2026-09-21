/**
 * Chamada ao LLM para o motor v2.
 * Gera JSON estruturado e valida com Zod; faz 1 retry se inválido.
 * Nenhum domínio de cliente.
 */

import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { getRequestContext, runWithContext } from "@/lib/request-context";
import { behaviorToTemperature } from "@/lib/ai-v2/response-behavior";
import { renderMessage } from "@/lib/ai-v2/message-render";
import {
  ToolCallGovernor,
  normalizeToolCallLimits,
  replayPayload,
  denialPayload,
  type ToolCallLimits,
} from "@/services/ai/tool-governor";
import type {
  V2Action,
  V2AgentConfig,
  V2LLMOutput,
  V2CRMContext,
} from "@/lib/ai-v2/types";
import {
  searchV2Products,
  searchV2CrmRecords,
  searchV2Knowledge,
  listV2MessageModels,
} from "./tools";

const v2ActionSchema: z.ZodType<V2Action> = z.object({
  type: z.enum([
    "add_tag",
    "update_field",
    "add_note",
    "create_deal",
    "move_stage",
    "create_activity",
    "send_message_model",
    "send_product",
    "send_whatsapp_template",
    "ask_with_options",
    "close_conversation",
    "tabulate_conversation",
    "handoff",
    "set_theme",
    "set_variable",
    "record_knowledge_gap",
    "start_survey",
  ]),
}).passthrough();

function flattenForRender(
  input: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flattenForRender(value as Record<string, unknown>, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

function activeTheme(config: V2AgentConfig, themeId?: string) {
  if (!themeId) return null;
  return config.themes.find((t) => t.id === themeId) ?? null;
}

export function buildV2ToolSet(args: {
  config: V2AgentConfig;
  context: V2CRMContext;
  agentId: string;
  apiKey: string;
  themeId?: string;
  limits?: ToolCallLimits;
}): { tools: ToolSet; governor: ToolCallGovernor } {
  const theme = activeTheme(args.config, args.themeId);
  const themeToolIds = theme?.allowedTools ? new Set(theme.allowedTools) : null;
  const allowedDocIds = theme?.knowledgeDocIds && theme.knowledgeDocIds.length > 0
    ? theme.knowledgeDocIds
    : args.config.allowedKnowledgeDocIds;
  const allowedModelIds = theme?.messageModelIds && theme.messageModelIds.length > 0
    ? theme.messageModelIds
    : args.config.allowedMessageModelIds;

  const enabledToolNames = new Set(args.config.enabledTools ?? []);
  if (enabledToolNames.size === 0 && !themeToolIds) {
    return { tools: {}, governor: new ToolCallGovernor(normalizeToolCallLimits(undefined)) };
  }

  const limits = args.limits ?? normalizeToolCallLimits({
    maxToolCallsPerRun: args.config.toolGovernor?.maxCallsPerTurn ?? 6,
    maxRepeatsPerTool: args.config.toolGovernor?.maxRepeatsPerTool ?? 2,
  });
  const governor = new ToolCallGovernor(limits);

  // Snapshot do RequestContext no momento em que o tool set é montado
  // (ainda dentro da mesma continuation síncrona do handler/job). O
  // `generateText` do AI SDK executa `tool.execute()` depois de uma
  // ida e volta HTTP à OpenAI — nessa travessia o AsyncLocalStorage
  // pode perder o store (observado em teste real: `knowledge_search`
  // explodia com "organization context ausente" mesmo com o handler
  // corretamente envolto em contexto). Reentrar o ctx aqui garante que
  // `prisma`/`getOrgIdOrThrow()` continuem scoped dentro do tool,
  // independente de como o SDK agenda a chamada.
  const capturedCtx = getRequestContext();

  function wrapTool(
    toolName: string,
    description: string,
    inputSchema: z.ZodTypeAny,
    execute: (input: any) => Promise<unknown>,
  ) {
    if (themeToolIds && !themeToolIds.has(toolName)) return undefined;
    if (!themeToolIds && !enabledToolNames.has(toolName)) return undefined;
    return tool({
      description,
      inputSchema,
      execute: async (input: unknown) => {
        const decision = governor.decide(toolName, input);
        if (decision.action === "deny") {
          return denialPayload(toolName, decision.reason);
        }
        if (decision.action === "replay") {
          return replayPayload(toolName, decision.previousResult);
        }
        try {
          const result = capturedCtx
            ? await runWithContext(capturedCtx, () => execute(input))
            : await execute(input);
          governor.record(toolName, input, result);
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failure = { ok: false as const, error: msg };
          governor.record(toolName, input, failure);
          return failure;
        }
      },
    });
  }

  const tools: ToolSet = {};

  const searchProducts = wrapTool(
    "search_products",
    "Busca produtos ou serviços ativos no catálogo interno. Use antes de responder preço, disponibilidade ou características.",
    z.object({
      query: z.string().min(1).describe("Termo de busca (nome, SKU, descrição, atributo)."),
      type: z.enum(["PRODUCT", "SERVICE"]).optional().describe("Filtro opcional por tipo."),
      limit: z.number().int().min(1).max(20).optional().describe("Máximo de resultados (1-20)."),
    }),
    async (input) =>
      searchV2Products({
        ...input,
        allowedIds: args.config.productPolicy?.enabled
          ? args.config.productPolicy.allowedProductIds
          : undefined,
      }),
  );
  if (searchProducts) tools.search_products = searchProducts;

  const searchCrm = wrapTool(
    "search_crm_records",
    "Busca dados de contatos e negócios no CRM. Use para localizar cadastro, histórico ou informações já registradas.",
    z.object({
      query: z.string().min(1).describe("Termo de busca livre."),
      scope: z
        .enum(["current_contact", "organization"])
        .optional()
        .describe("'current_contact' (padrão) restringe ao contato/negócio atual. 'organization' busca em todo o CRM."),
      limit: z.number().int().min(1).max(10).optional().describe("Máximo de resultados (1-10)."),
    }),
    async (input) =>
      searchV2CrmRecords({
        ...input,
        contactId: args.context.contact?.id as string | undefined,
        dealId: args.context.selectedDeal?.id as string | undefined,
      }),
  );
  if (searchCrm) tools.search_crm_records = searchCrm;

  const knowledge = wrapTool(
    "knowledge_search",
    "Busca trechos relevantes na base de conhecimento do agente. Use para fundamentar respostas e evitar inventar dados.",
    z.object({
      query: z.string().min(1).describe("Pergunta ou termo de busca na base."),
      limit: z.number().int().min(1).max(5).optional().describe("Máximo de trechos (1-5)."),
    }),
    async (input) =>
      searchV2Knowledge({
        agentId: args.agentId,
        apiKey: args.apiKey,
        query: input.query,
        allowedDocIds,
        limit: input.limit,
      }),
  );
  if (knowledge) tools.knowledge_search = knowledge;

  const messageModels = wrapTool(
    "list_message_models",
    "Lista modelos de mensagem internos (templates operacionais) relevantes à pergunta. Use para seguir procedimentos já cadastrados.",
    z.object({
      query: z.string().min(1).describe("Assunto ou palavras-chave da mensagem."),
      limit: z.number().int().min(1).max(5).optional().describe("Máximo de modelos (1-5)."),
    }),
    async (input) =>
      listV2MessageModels({
        query: input.query,
        allowedIds: allowedModelIds,
        limit: input.limit,
      }),
  );
  if (messageModels) tools.list_message_models = messageModels;

  return { tools, governor };
}

const v2LLMOutputSchema: z.ZodType<V2LLMOutput> = z.object({
  reply: z.string(),
  theme: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" ? v : undefined)),
  messageModel: z
    .union([
      z.object({ id: z.string(), adapt: z.boolean().optional().default(false) }),
      z.null(),
    ])
    .optional()
    .transform((v) => (v && typeof v === "object" && "id" in v ? v : undefined)),
  handoff: z.boolean().optional().default(false),
  concluded: z.boolean().optional().default(false),
  confirmed: z.boolean().nullable().optional().default(null),
  outOfScope: z.boolean().optional().default(false),
  sentiment: z.enum(["neutral", "dissatisfied", "angry"]).optional().default("neutral"),
  tabulationId: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" ? v : undefined)),
  collected: z.record(z.string(), z.string()).optional().default({}),
  reason: z.string().optional().default(""),
  actions: z.array(v2ActionSchema).optional().default([]),
}) as unknown as z.ZodType<V2LLMOutput>;

export async function callV2LLMTest(
  agentId: string,
  config: V2AgentConfig,
  userMessage: string,
  previousMessages: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<ReturnType<typeof callV2LLM>> {
  const emptyContext: V2CRMContext = {
    contact: null,
    deals: [],
    selectedDeal: null,
    fields: config.contextFields,
  };
  return callV2LLM({
    agentId,
    config,
    context: emptyContext,
    userMessage,
    stage: "active",
    previousMessages,
  });
}

function buildV2SystemPrompt(
  config: V2AgentConfig,
  context: V2CRMContext,
  stage: string,
  themeId?: string,
  themeInstructions?: string,
  collectedVariables?: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`# Tom de voz\n${config.tone}`);
  lines.push(`# Regras globais\n${config.globalRules.join("\n")}`);

  lines.push("# Dados do cliente (só cite o que está aqui)");
  if (context.contact && Object.keys(context.contact).length > 0) {
    lines.push(`Contato: ${JSON.stringify(context.contact)}`);
  }
  if (context.selectedDeal && Object.keys(context.selectedDeal).length > 0) {
    lines.push(`Negócio: ${JSON.stringify(context.selectedDeal)}`);
  } else {
    lines.push("Negócio: nenhum encontrado.");
  }

  if (config.variables.length > 0) {
    lines.push("# Informações fixas da empresa");
    for (const v of config.variables) lines.push(`${v.key}: ${v.value}`);
  }

  if (themeInstructions) {
    lines.push(`# Tema ativo: ${themeId}`);
    lines.push(themeInstructions);
  }

  if (collectedVariables && Object.keys(collectedVariables).length > 0) {
    lines.push("# Variáveis já coletadas nesta conversa");
    lines.push(JSON.stringify(collectedVariables));
  }

  lines.push(`# Etapa atual\n${stage}`);
  lines.push("# Tools de consulta disponíveis");
  lines.push("Antes de responder, você pode chamar: search_products, search_crm_records, knowledge_search, list_message_models. Não chame a mesma tool com os mesmos argumentos mais de uma vez.");
  lines.push("# Saída obrigatória");
  lines.push("Responda com um JSON EXATAMENTE neste formato:");
  lines.push(JSON.stringify({
    reply: "texto para o cliente",
    theme: "id do tema (opcional)",
    messageModel: { id: "id do modelo interno", adapt: false },
    handoff: false,
    concluded: false,
    confirmed: null,
    outOfScope: false,
    sentiment: "neutral",
    tabulationId: "id da tabulação (opcional)",
    collected: { "campo": "valor" },
    reason: "por que respondeu assim",
    actions: [{ type: "handoff" }],
  }, null, 2));
  lines.push("Nunca afirme ao cliente que executou uma ação que não esteja em 'actions'.");
  lines.push("Nunca prometa verificar e retornar depois. Se depender de outra pessoa, marque handoff=true.");

  return lines.join("\n\n");
}

export async function callV2LLM(args: {
  agentId: string;
  config: V2AgentConfig;
  context: V2CRMContext;
  userMessage: string;
  stage: string;
  themeId?: string;
  themeInstructions?: string;
  collectedVariables?: Record<string, unknown>;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{
  output: V2LLMOutput;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  governorStats: { totalCalls: number; replays: number; denials: number; limitHit: boolean };
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
}> {
  const apiKey = await getAgentApiKey(args.agentId);
  const system = buildV2SystemPrompt(
    args.config,
    args.context,
    args.stage,
    args.themeId,
    args.themeInstructions,
    args.collectedVariables,
  );

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(args.previousMessages ?? []),
    { role: "user", content: args.userMessage },
  ];

  const startedAt = Date.now();
  const { tools, governor } = buildV2ToolSet({
    config: args.config,
    context: args.context,
    agentId: args.agentId,
    apiKey,
    themeId: args.themeId,
  });
  const hasTools = Object.keys(tools).length > 0;

  const renderVars = flattenForRender({
    contact: args.context.contact ?? {},
    deal: args.context.selectedDeal ?? {},
    ...((args.collectedVariables as Record<string, unknown>) ?? {}),
  });

  async function attempt(): Promise<{
    output: V2LLMOutput;
    inputTokens: number;
    outputTokens: number;
    toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
  }> {
    const result = await generateWithTools({
      model: args.config.model,
      apiKey,
      system,
      messages: messages as any,
      tools,
      temperature: behaviorToTemperature(args.config.responseBehavior),
      maxSteps: hasTools ? (args.config.toolGovernor?.maxCallsPerTurn ?? 6) + 1 : 1,
    });

    const text = result.text.trim();
    const jsonText = text.replace(/^```json\s*/, "").replace(/```\s*$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("LLM output is not valid JSON");
    }

    const validated = v2LLMOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Invalid LLM output schema: ${validated.error.message}`);
    }

    const output = validated.data as V2LLMOutput;

    // Aplica renderizador de mensagens em todas as respostas.
    output.reply = renderMessage(output.reply, renderVars) ?? output.reply;

    return {
      output,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls,
    };
  }

  let lastError: Error | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await attempt();
      return { ...r, latencyMs: Date.now() - startedAt, governorStats: governor.stats() };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("LLM failed");
}
