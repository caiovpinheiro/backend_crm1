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
import { listKnowledgeDocs } from "@/services/ai/knowledge-docs";
import { knowledgeDocIdsFor } from "./themes";
import { hasSearchableQuestion } from "./ground-reply";

type PrefetchedChunk = { docId: string; docTitle: string; content: string; distance: number };

const PREFETCH_LIMIT = 3;
const PREFETCH_CHUNK_CHARS = 1500;

function contentWordCount(text: string): number {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4).length;
}

/**
 * Texto da busca: a mensagem do turno; se for um acompanhamento curto
 * ("consegue me enviar?"), junta a pergunta anterior do cliente para a
 * busca ter do que se tratar.
 */
export function knowledgePrefetchQuery(
  userMessage: string,
  previousMessages: Array<{ role: "user" | "assistant"; content: string }> = [],
): string {
  const msg = userMessage.trim();
  if (contentWordCount(msg) >= 3) return msg;
  const lastUser = [...previousMessages].reverse().find((m) => m.role === "user" && m.content.trim());
  return lastUser ? `${lastUser.content.trim()}\n${msg}` : msg;
}

/**
 * Busca na base ANTES do LLM, pelo significado da mensagem (embeddings).
 * Antes o material só entrava se o modelo decidisse chamar
 * `knowledge_search` — e a escolha do que buscar dependia de gatilhos por
 * palavra. Com a pré-busca, "preciso de um comprovante de X" já chega ao
 * modelo junto do material que explica como emitir o documento de X,
 * mesmo sem nenhum termo em comum cadastrado.
 */
async function prefetchKnowledge(args: {
  agentId: string;
  apiKey: string;
  config: V2AgentConfig;
  themeId?: string;
  userMessage: string;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ query: string; chunks: PrefetchedChunk[] }> {
  const docIds = knowledgeDocIdsFor(args.config, activeTheme(args.config, args.themeId));
  const query = knowledgePrefetchQuery(args.userMessage, args.previousMessages);
  if (docIds.length === 0 || !hasSearchableQuestion(query)) return { query, chunks: [] };
  try {
    const found = await searchV2Knowledge({
      agentId: args.agentId,
      apiKey: args.apiKey,
      query,
      allowedDocIds: docIds,
      limit: PREFETCH_LIMIT,
    });
    return { query, chunks: found?.chunks ?? [] };
  } catch (err) {
    console.warn("[ai-v2] pré-busca na base falhou:", err instanceof Error ? err.message : err);
    return { query, chunks: [] };
  }
}

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
  const allowedDocIds = knowledgeDocIdsFor(args.config, theme);
  // A tela grava os modelos do assunto em `allowedMessageModelIds`;
  // `messageModelIds` é o nome legado. Lendo só o legado a restrição do
  // assunto era ignorada e valia a lista global.
  const allowedModelIds = theme?.allowedMessageModelIds && theme.allowedMessageModelIds.length > 0
    ? theme.allowedMessageModelIds
    : theme?.messageModelIds && theme.messageModelIds.length > 0
      ? theme.messageModelIds
      : args.config.allowedMessageModelIds;

  const enabledToolNames = new Set(args.config.enabledTools ?? []);

  // Se nenhum tema nem lista global de tools foi configurada, infere
  // ferramentas de consulta a partir dos dados disponíveis — senão um
  // agente com materiais/produtos/modelos cadastrados fica sem ferramentas
  // quando nenhum assunto casa com a mensagem.
  const defaultToolNames = new Set<string>();
  const docIds = allowedDocIds ?? [];
  if (docIds.length > 0) defaultToolNames.add("knowledge_search");
  const modelIds = allowedModelIds ?? [];
  if (modelIds.length > 0) defaultToolNames.add("list_message_models");
  if (args.config.productPolicy?.enabled) defaultToolNames.add("search_products");
  if (
    args.context.fields.contact.some((f) => f.permissions.includes("read") || f.permissions.includes("cite")) ||
    args.context.fields.deal.some((f) => f.permissions.includes("read") || f.permissions.includes("cite"))
  ) {
    defaultToolNames.add("search_crm_records");
  }

  const limits = args.limits ?? normalizeToolCallLimits({
    maxToolCallsPerRun: args.config.toolGovernor?.maxCallsPerTurn ?? 6,
    maxRepeatsPerTool: args.config.toolGovernor?.maxRepeatsPerTool ?? 2,
  });
  const governor = new ToolCallGovernor(limits);

  function isToolAllowed(toolName: string): boolean {
    if (themeToolIds) return themeToolIds.has(toolName);
    if (enabledToolNames.size > 0) return enabledToolNames.has(toolName);
    return defaultToolNames.has(toolName);
  }

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
    if (!isToolAllowed(toolName)) return undefined;
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
          // DIAGNÓSTICO TEMPORÁRIO (remover após achar a causa do bug
          // "organization context ausente" em prod/dev — ver ai-v2 RAG):
          // expõe se capturedCtx existia no momento em que a tool foi
          // montada, pra distinguir "nunca capturou" de "capturou mas
          // perdeu no meio do execute()".
          const diag = `capturedCtxAtBuild=${capturedCtx ? `org:${capturedCtx.organizationId}` : "AUSENTE"} ctxNoCatch=${getRequestContext() ? `org:${getRequestContext()?.organizationId}` : "AUSENTE"}`;
          const failure = { ok: false as const, error: `${msg} [[diag: ${diag}]]` };
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

  // Chaves que a config libera para leitura — a tool não devolve nada além.
  const crmReadableKeys = [
    ...args.context.fields.contact
      .filter((f) => f.permissions.includes("read") || f.permissions.includes("cite"))
      .map((f) => `contact.${f.key}`),
    ...args.context.fields.deal
      .filter((f) => f.permissions.includes("read") || f.permissions.includes("cite"))
      .map((f) => `deal.${f.key}`),
  ];
  const searchCrm = wrapTool(
    "search_crm_records",
    "Consulta o cadastro do cliente desta conversa e os negócios dele. Não busca outras pessoas.",
    z.object({
      query: z.string().min(1).describe("Termo de busca livre."),
      limit: z.number().int().min(1).max(10).optional().describe("Máximo de resultados (1-10)."),
    }),
    async (input) =>
      searchV2CrmRecords({
        query: input.query,
        limit: input.limit,
        // `context.contact` é indexado pelo rótulo do campo — o id vem do bruto.
        contactId: (args.context.contactRaw?.id ?? args.context.contact?.id) as string | undefined,
        dealId: (args.context.selectedDealRaw?.id ?? args.context.selectedDeal?.id) as string | undefined,
        readableKeys: crmReadableKeys,
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
      z.object({
        id: z.unknown().transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null)),
        adapt: z.boolean().optional().default(false),
        variables: z.record(z.string(), z.string()).optional().default({}),
      }),
      z.null(),
    ])
    .optional()
    .transform((v) => {
      if (!v || typeof v !== "object" || v === null) return undefined;
      const id = (v as { id?: string | null }).id;
      if (!id || typeof id !== "string") return undefined;
      return {
        id,
        adapt: (v as { adapt?: boolean }).adapt ?? false,
        variables: (v as { variables?: Record<string, string> }).variables ?? {},
      };
    }),
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

function extractFirstJSONObject(text: string): string | undefined {
  // Tenta isolar o primeiro objeto JSON válido do texto.
  let firstBrace = text.indexOf("{");
  while (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === "{") {
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0) {
            return text.slice(firstBrace, i + 1);
          }
        }
      }
    }
    firstBrace = text.indexOf("{", firstBrace + 1);
  }
  return undefined;
}

function buildErrorFallbackOutput(config: V2AgentConfig, rawText: string): V2LLMOutput {
  const fallback = config.fallback?.error?.message ?? config.fallback?.noSource?.message;
  const reply = fallback || "Não consegui processar sua mensagem. Vou transferir para um atendente.";
  console.warn("[ai-v2] LLM não retornou JSON válido. Fallback de erro aplicado. Texto bruto:", rawText.slice(0, 500));
  return {
    reply,
    handoff: true,
    concluded: false,
    confirmed: null,
    outOfScope: false,
    sentiment: "neutral",
    collected: {},
    reason: "LLM não retornou JSON válido — fallback de erro aplicado.",
    actions: [{ type: "handoff" }],
  };
}

function buildInvalidJsonFallbackOutput(config: V2AgentConfig, rawText: string): V2LLMOutput {
  const cleaned = rawText.trim();
  if (!cleaned) {
    return buildErrorFallbackOutput(config, rawText);
  }
  // JSON quebrado (cortado, fora do schema) não pode virar mensagem para o
  // cliente — iria o `{"reply": ...` cru. Só texto livre de verdade vira reply.
  if (/^[\s`]*(json)?[\s`]*[{[]/i.test(cleaned) || /"reply"\s*:/.test(cleaned)) {
    return buildErrorFallbackOutput(config, rawText);
  }
  console.warn("[ai-v2] LLM não devolveu JSON válido. Usando texto livre como reply. Texto bruto:", cleaned.slice(0, 500));
  return {
    reply: cleaned.slice(0, 2000),
    handoff: false,
    concluded: false,
    confirmed: null,
    outOfScope: false,
    sentiment: "neutral",
    collected: {},
    reason: "LLM devolveu texto livre — resposta usada como reply; schema ignorado.",
    actions: [],
  };
}

/**
 * Última tentativa de normalizar texto livre do LLM em JSON válido.
 * Roda um passo extra sem tools, pedindo apenas para reformatar o rascunho
 * no schema obrigatório. Usado como rede de segurança genérica.
 */
async function coerceV2OutputFromRawText(args: {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  rawText: string;
  model: string;
  apiKey: string;
  responseBehavior: V2AgentConfig["responseBehavior"];
  maxOutputTokens?: number;
}): Promise<{
  output?: V2LLMOutput;
  inputTokens: number;
  outputTokens: number;
}> {
  const correctorSystem = [
    args.system,
    "",
    "# NORMALIZAÇÃO FINAL",
    "A resposta acima foi gerada em texto livre. Reescreva-a como um ÚNICO objeto JSON válido no formato exigido. Preserve o conteúdo do 'reply', ajustando apenas para o tom e formato do canal se necessário. Preencha os campos obrigatórios: handoff, concluded, confirmed, outOfScope, sentiment, collected, reason, actions. Não inclua texto fora do JSON.",
  ].join("\n\n");

  const correctorMessages = [...args.messages, { role: "assistant" as const, content: args.rawText }];
  try {
    const result = await generateWithTools({
      model: args.model,
      apiKey: args.apiKey,
      system: correctorSystem,
      messages: correctorMessages as any,
      temperature: behaviorToTemperature(args.responseBehavior),
      maxOutputTokens: args.maxOutputTokens ?? responseLengthToMaxTokens("medium"),
      maxSteps: 1,
    });

    const text = result.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: unknown | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      const extracted = extractFirstJSONObject(text) ?? extractFirstJSONObject(result.text);
      if (extracted) {
        try {
          parsed = JSON.parse(extracted);
        } catch {
          parsed = undefined;
        }
      }
    }

    const validated = parsed ? v2LLMOutputSchema.safeParse(parsed) : undefined;
    if (validated?.success) {
      return { output: validated.data as V2LLMOutput, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    }
    return { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[ai-v2] Falha na normalização de JSON:", msg);
    return { inputTokens: 0, outputTokens: 0 };
  }
}

export async function callV2LLMTest(
  agentId: string,
  config: V2AgentConfig,
  userMessage: string,
  previousMessages: Array<{ role: "user" | "assistant"; content: string }> = [],
  context?: V2CRMContext,
  themeId?: string | null,
): Promise<{
  output: V2LLMOutput;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  governorStats: { totalCalls: number; replays: number; denials: number; limitHit: boolean };
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
  wasExpanded: boolean;
  systemPrompt: string;
}> {
  const ctx: V2CRMContext = context ?? {
    contact: null,
    deals: [],
    selectedDeal: null,
    fields: config.contextFields,
  };
  const theme = themeId ? config.themes.find((t) => t.id === themeId) : undefined;
  const result = await callV2LLM({
    agentId,
    config,
    context: ctx,
    userMessage,
    stage: "active",
    themeId: theme?.id,
    themeInstructions: theme
      ? `${theme.instructions}\nFerramentas permitidas: ${theme.allowedTools.join(", ")}`
      : undefined,
    previousMessages,
  });
  return result;
}

function responseLengthToMaxTokens(length: V2AgentConfig["responseLength"]): number {
  // Rede de segurança com folga para a saída estruturada completa
  // (reply + theme + reason + actions). O controle real de tamanho vem
  // da instrução no system prompt.
  switch (length) {
    case "short":
      return 600;
    case "long":
      return 2000;
    case "medium":
    default:
      return 1000;
  }
}

function responseLengthInstruction(length: V2AgentConfig["responseLength"]): string {
  switch (length) {
    case "short":
      return "Mantenha as respostas curtas e diretas (ideal: até 2 parágrafos).";
    case "long":
      return "Pode responder com mais detalhes e explicações quando necessário.";
    case "medium":
    default:
      return "Responda de forma equilibrada, nem muito curta nem muito longa.";
  }
}

function buildV2SystemPrompt(
  config: V2AgentConfig,
  context: V2CRMContext,
  stage: string,
  themeId?: string,
  themeInstructions?: string,
  collectedVariables?: Record<string, unknown>,
  allowedToolNames?: string[],
  knowledgeDocTitles?: string[],
  prefetchedChunks: PrefetchedChunk[] = [],
): string {
  const lines: string[] = [];
  lines.push(`# Tom de voz\n${config.tone}`);
  lines.push(`# Tamanho das respostas\n${responseLengthInstruction(config.responseLength)}`);
  lines.push(`# Regras globais\n${config.globalRules.join("\n")}`);

  // Dados que o modelo pode usar para entender a situação.
  lines.push("# Dados do cliente para consulta interna");
  const hasReadableContact = context.contact && Object.keys(context.contact).length > 0;
  const hasReadableDeal = context.selectedDeal && Object.keys(context.selectedDeal).length > 0;
  if (hasReadableContact) {
    lines.push(`Contato: ${JSON.stringify(context.contact)}`);
  }
  if (hasReadableDeal) {
    lines.push(`Negócio: ${JSON.stringify(context.selectedDeal)}`);
  } else {
    lines.push("Negócio: nenhum encontrado.");
  }
  if (!hasReadableContact && !hasReadableDeal) {
    lines.push("Nenhum contato encontrado para esta conversa.");
  }

  // Dados que o modelo pode repetir/citar na resposta ao cliente.
  const citableContact = context.citableContact ?? context.contact;
  const citableDeal = context.citableDeal ?? context.selectedDeal;
  const hasCitableContact = citableContact && Object.keys(citableContact).length > 0;
  const hasCitableDeal = citableDeal && Object.keys(citableDeal).length > 0;
  if (hasCitableContact || hasCitableDeal) {
    lines.push("# Dados que você pode citar na resposta");
    if (hasCitableContact) lines.push(`Contato: ${JSON.stringify(citableContact)}`);
    if (hasCitableDeal) lines.push(`Negócio: ${JSON.stringify(citableDeal)}`);
  }
  lines.push("Regra de citação: só escreva/repita para o cliente os campos listados em 'Dados que você pode citar na resposta'. Campos de 'Dados do cliente para consulta interna' servem apenas para você entender a situação.");

  // Negócios abertos: listar quando há mais de um e o modo é perguntar.
  if (context.deals && context.deals.length > 1 && !context.selectedDeal && config.dealSelection === "ask") {
    lines.push("# Negócios abertos do cliente");
    for (let i = 0; i < context.deals.length; i++) {
      const d = context.deals[i];
      lines.push(`${i + 1}. ${d.title ?? "Negócio sem título"} (${d.stageName ?? "sem etapa"})`);
    }
    lines.push("Pergunte ao cliente qual destes negócios ele quer tratar. Não responda sobre nenhum deles antes de saber a escolha.");
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
  if (stage === "confirming") {
    lines.push("Você está confirmando a identidade do cliente. Se ele confirmar que é ele (sim/confirma), devolva confirmed: true. Se ele negar ou pedir para falar de outra pessoa, devolva confirmed: false. Se a resposta for irrelevante, devolva confirmed: null.");
  }
  lines.push("# Tools de consulta disponíveis");
  const allQueryTools = ["search_products", "search_crm_records", "knowledge_search", "list_message_models"];
  const availableTools = allQueryTools.filter((t) => (allowedToolNames ?? []).includes(t));
  lines.push(`Antes de responder, você pode chamar: ${availableTools.join(", ") || "(nenhuma tool configurada)"}. Não chame a mesma tool com os mesmos argumentos mais de uma vez.`);
  const promptTheme = activeTheme(config, themeId);
  const promptDocIds = knowledgeDocIdsFor(config, promptTheme);
  if (availableTools.includes("knowledge_search") && promptDocIds.length > 0) {
    lines.push("Há materiais de consulta disponíveis. Sempre que a pergunta do cliente puder ser respondida por esses materiais, chame knowledge_search primeiro. Se a busca retornar trechos relevantes, responda com base neles. Se não retornar nada, marque handoff=true em vez de inventar.");
    if (knowledgeDocTitles && knowledgeDocTitles.length > 0) {
      lines.push(`Materiais permitidos: ${knowledgeDocTitles.map((t) => `"${t}"`).join(", ")}. Use knowledge_search quando a pergunta se relacionar a um desses títulos.`);
    }
  }
  if (prefetchedChunks.length > 0) {
    lines.push("# Trechos da base de conhecimento relacionados à mensagem");
    lines.push("Encontrados pelo significado da mensagem, mesmo que o cliente tenha usado outras palavras. Se algum trecho atende ao que o cliente pediu, responda com base nele. Se nenhum for pertinente, ignore-os e não os mencione.");
    prefetchedChunks.forEach((c, i) => {
      const body = c.content.length > PREFETCH_CHUNK_CHARS ? `${c.content.slice(0, PREFETCH_CHUNK_CHARS)}…` : c.content;
      lines.push(`[${i + 1}] ${c.docTitle}\n${body}`);
    });
  }
  lines.push("# Formato da resposta");
  lines.push("Mantenha o tom configurado. Se usar trechos de materiais de consulta que contenham listas numeradas, marcadores, emojis ou passos técnicos, reescreva em linguagem natural do canal (frases curtas, sem enumerar). Nunca envie menus ou listas de departamentos.");
  lines.push("# Saída obrigatória");
  lines.push("Sua resposta final deve ser APENAS um objeto JSON válido no formato abaixo. Não inclua markdown, explicações, saudações ou qualquer texto fora do JSON.");
  lines.push(JSON.stringify({
    reply: "texto para o cliente",
    theme: "id do tema (opcional)",
    messageModel: null,
    handoff: false,
    concluded: false,
    confirmed: null,
    outOfScope: false,
    sentiment: "neutral",
    tabulationId: "id da tabulação (opcional)",
    collected: { "campo": "valor" },
    reason: "por que respondeu assim",
    actions: [],
  }, null, 2));
  // O exemplo trazia `actions: [{ type: "handoff" }]`: o modelo copiava e
  // pedia transferência sem motivo.
  lines.push("actions: lista de ações a executar neste turno — vazia quando não há ação. Para transferir para um atendente use handoff: true (ou a ação { type: \"handoff\" }) apenas quando realmente precisar de um humano.");
  lines.push("messageModel: pode ser null ou um objeto com { id: string, adapt?: boolean, variables?: {chave: valor} }. Nunca use um objeto vazio ou outro formato.");
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
  wasExpanded: boolean;
  systemPrompt: string;
}> {
  const apiKey = await getAgentApiKey(args.agentId);
  const { tools, governor } = buildV2ToolSet({
    config: args.config,
    context: args.context,
    agentId: args.agentId,
    apiKey,
    themeId: args.themeId,
  });
  const allowedToolNames = Object.keys(tools);

  // Carrega os títulos dos materiais permitidos para ajudar o modelo a
  // decidir quando chamar knowledge_search e a contextualizar a resposta.
  const promptTheme = activeTheme(args.config, args.themeId);
  const promptDocIds = knowledgeDocIdsFor(args.config, promptTheme);
  let knowledgeDocTitles: string[] = [];
  if (promptDocIds.length > 0) {
    try {
      const docs = await listKnowledgeDocs({ agentId: args.agentId });
      const allowedSet = new Set(promptDocIds);
      knowledgeDocTitles = docs.items.filter((d) => allowedSet.has(d.id)).map((d) => d.title);
    } catch (err) {
      console.warn("[ai-v2] Erro ao carregar títulos dos materiais:", err instanceof Error ? err.message : err);
    }
  }

  const prefetch = await prefetchKnowledge({
    agentId: args.agentId,
    apiKey,
    config: args.config,
    themeId: args.themeId,
    userMessage: args.userMessage,
    previousMessages: args.previousMessages,
  });
  // Entra no trace como uma consulta à base: o aterramento da resposta e o
  // log do turno enxergam os trechos. Só quando achou algo — pré-busca
  // vazia não pode contar como "consultou e não achou".
  const prefetchCalls = prefetch.chunks.length > 0
    ? [{ toolName: "knowledge_search", args: { query: prefetch.query, prefetch: true }, result: { query: prefetch.query, chunks: prefetch.chunks } }]
    : [];

  const system = buildV2SystemPrompt(
    args.config,
    args.context,
    args.stage,
    args.themeId,
    args.themeInstructions,
    args.collectedVariables,
    allowedToolNames,
    knowledgeDocTitles,
    prefetch.chunks,
  );

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(args.previousMessages ?? []),
    { role: "user", content: args.userMessage },
  ];

  const startedAt = Date.now();
  const hasTools = allowedToolNames.length > 0;

  const configVars: Record<string, unknown> = {};
  for (const v of args.config.variables) configVars[v.key] = v.value;

  const renderVars = flattenForRender({
    contact: args.context.contact ?? {},
    deal: args.context.selectedDeal ?? {},
    ...configVars,
    ...((args.collectedVariables as Record<string, unknown>) ?? {}),
  });

  async function attempt(): Promise<{
    output: V2LLMOutput;
    inputTokens: number;
    outputTokens: number;
    toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
    wasExpanded?: boolean;
  }> {
    let result = await generateWithTools({
      model: args.config.model,
      apiKey,
      system,
      messages: messages as any,
      tools,
      temperature: behaviorToTemperature(args.config.responseBehavior),
      maxOutputTokens: responseLengthToMaxTokens(args.config.responseLength),
      maxSteps: hasTools ? (args.config.toolGovernor?.maxCallsPerTurn ?? 6) + 1 : 1,
    });

    // Se o modelo cortou por limite de tokens, tenta novamente com a rede de
    // segurança mais ampla (long) em vez de devolver JSON quebrado.
    let wasExpanded = false;
    if (result.finishReason === "length") {
      wasExpanded = true;
      console.warn("[ai-v2] LLM resposta cortada por length; expandindo maxOutputTokens");
      result = await generateWithTools({
        model: args.config.model,
        apiKey,
        system,
        messages: messages as any,
        tools,
        temperature: behaviorToTemperature(args.config.responseBehavior),
        maxOutputTokens: responseLengthToMaxTokens("long"),
        maxSteps: hasTools ? (args.config.toolGovernor?.maxCallsPerTurn ?? 6) + 1 : 1,
      });
    }

    let text = result.text.trim();
    // Remove fences de markdown e "json" solto no início/fim.
    let jsonText = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    if (jsonText.toLowerCase().startsWith("json")) {
      jsonText = jsonText.slice(4).trim();
    }

    let parsed: unknown | undefined;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      const extracted = extractFirstJSONObject(jsonText) ?? extractFirstJSONObject(text);
      if (extracted) {
        try {
          parsed = JSON.parse(extracted);
        } catch {
          parsed = undefined;
        }
      }
    }

    let validated = parsed ? v2LLMOutputSchema.safeParse(parsed) : undefined;
    let correctorTokens = { input: 0, output: 0 };

    if (!validated?.success && text.trim()) {
      const coerced = await coerceV2OutputFromRawText({
        system,
        messages,
        rawText: text,
        model: args.config.model,
        apiKey,
        responseBehavior: args.config.responseBehavior,
        maxOutputTokens: responseLengthToMaxTokens(args.config.responseLength),
      });
      correctorTokens = { input: coerced.inputTokens, output: coerced.outputTokens };
      if (coerced.output) {
        parsed = coerced.output;
        validated = v2LLMOutputSchema.safeParse(parsed);
      }
    }

    if (!validated?.success) {
      if (!validated) {
        console.warn("[ai-v2] LLM não devolveu JSON válido; normalizador também falhou. Texto:", text.slice(0, 500));
      } else {
        console.warn("[ai-v2] LLM devolveu JSON fora do schema:", validated.error.message, "texto:", text.slice(0, 500));
      }
      return {
        output: buildInvalidJsonFallbackOutput(args.config, text),
        inputTokens: result.inputTokens + correctorTokens.input,
        outputTokens: result.outputTokens + correctorTokens.output,
        toolCalls: result.toolCalls,
        wasExpanded,
      };
    }

    const output = validated.data as V2LLMOutput;

    // Alerta quando o LLM devolve messageModel com id inválido.
    const rawMessageModel = (parsed as Record<string, unknown>)?.messageModel;
    if (rawMessageModel && typeof rawMessageModel === "object" && rawMessageModel !== null) {
      const rawId = (rawMessageModel as { id?: unknown }).id;
      if (rawId !== undefined && rawId !== null && typeof rawId !== "string") {
        console.warn("[ai-v2] LLM devolveu messageModel.id inválido; ignorado.", rawId);
      }
    }

    // messageModel é uma forma curta de devolver a ação send_message_model.
    if (output.messageModel?.id) {
      output.actions = [
        { type: "send_message_model", modelId: output.messageModel.id, variables: output.messageModel.variables },
        ...output.actions,
      ];
    }

    // Aplica renderizador de mensagens em todas as respostas.
    output.reply = renderMessage(output.reply, renderVars) ?? output.reply;

    return {
      output,
      inputTokens: result.inputTokens + correctorTokens.input,
      outputTokens: result.outputTokens + correctorTokens.output,
      toolCalls: result.toolCalls,
      wasExpanded,
    };
  }

  let lastError: Error | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await attempt();
      return {
        ...r,
        toolCalls: [...prefetchCalls, ...(r.toolCalls ?? [])],
        latencyMs: Date.now() - startedAt,
        governorStats: governor.stats(),
        systemPrompt: system,
      } as any;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("LLM failed");
}
