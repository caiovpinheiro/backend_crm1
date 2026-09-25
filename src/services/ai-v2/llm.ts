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
import { knowledgeDocTitlesByIds } from "@/services/ai/knowledge-docs";
import { describeV2MessageModels, type V2MessageModelSummary } from "./tools";
import { knowledgeDocIdsFor } from "./themes";
import { hasSearchableQuestion, isNearDuplicateReply, knowledgeChunkTexts, unsupportedFigures, unsupportedHedges, unsupportedQuotedTerms } from "./ground-reply";
import { traceStep } from "./trace";
import { SensitiveVault } from "./sensitive";
import { breakInlineSteps } from "./reply-format";
import { markPastDates } from "./dates";
import { calendarPromptSection } from "./calendar";
import { QUERY_TOOL_NAMES, themePromptText } from "./theme-prompt";
import { actionsGuide, allowedActionTypes, allowedMessageModelIdsFor, queryToolRestriction, themeToolRestriction } from "./action-policy";

type PrefetchedChunk = { docId: string; docTitle: string; content: string; distance: number };

const PREFETCH_LIMIT = 5;
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
/** Liga/desliga a reformulação (AI_V2_QUERY_REWRITE=0 desliga). */
function queryRewriteEnabled(): boolean {
  return (process.env.AI_V2_QUERY_REWRITE ?? "1").trim() !== "0";
}

const MAX_REWRITES = 3;
const MAX_TITLES_IN_REWRITE = 150;

/**
 * Reformula o pedido do cliente em consultas curtas de busca.
 *
 * A busca por significado com a frase crua do cliente ("estão pedindo uma
 * comprovação de que eu sou cliente de vocês") compete com todo o resto da
 * frase; o material que resolve costuma ter um título formal ("Como emitir
 * X"). O modelo recebe os títulos dos materiais liberados e devolve até 3
 * consultas no vocabulário da base. Falha, demora ou JSON inválido → segue
 * só com a frase original.
 */
export async function rewriteKnowledgeQueries(args: {
  model: string;
  apiKey: string;
  userMessage: string;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  materialTitles?: string[];
}): Promise<string[]> {
  const recent = (args.previousMessages ?? []).slice(-4)
    .map((m) => `${m.role === "user" ? "Cliente" : "Atendente"}: ${m.content.slice(0, 300)}`)
    .join("\n");
  const titles = (args.materialTitles ?? []).slice(0, MAX_TITLES_IN_REWRITE);
  const system = [
    "Você transforma a mensagem de um cliente em consultas de busca para uma base de conhecimento de atendimento.",
    "Identifique o que o cliente precisa (um documento, um procedimento, uma informação, um problema) e escreva consultas curtas (2 a 8 palavras), no vocabulário que um material de atendimento usaria — termos formais e sinônimos do que o cliente disse com palavras informais.",
    titles.length > 0
      ? `Títulos dos materiais disponíveis (use o vocabulário deles quando algum corresponder ao pedido):\n${titles.map((t) => `- ${t}`).join("\n")}`
      : "",
    `Responda APENAS um JSON: {"queries": ["...", "..."]} com no máximo ${MAX_REWRITES} consultas. Se a mensagem não pede nada que se busque numa base (saudação, agradecimento), responda {"queries": []}.`,
  ].filter(Boolean).join("\n\n");
  const user = recent ? `Conversa recente:\n${recent}\n\nMensagem atual do cliente:\n${args.userMessage}` : args.userMessage;

  const result = await generateWithTools({
    model: args.model,
    apiKey: args.apiKey,
    system,
    messages: [{ role: "user", content: user }] as any,
    temperature: 0,
    maxOutputTokens: 200,
    maxSteps: 1,
  });
  const text = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const extracted = extractFirstJSONObject(text);
    parsed = extracted ? JSON.parse(extracted) : undefined;
  }
  const queries = (parsed as { queries?: unknown } | undefined)?.queries;
  if (!Array.isArray(queries)) return [];
  return [...new Set(queries.filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter(Boolean))]
    .slice(0, MAX_REWRITES);
}

/** Junta os trechos de várias buscas: um por trecho, o mais próximo primeiro. */
/**
 * Junta os resultados das consultas (frase do cliente + reformulações).
 * O melhor trecho de CADA consulta entra primeiro; o resto completa por
 * distância. Só por distância, uma consulta genérica que casa bem com um
 * material (0,76) tirava o trecho que responde a consulta específica
 * (0,66).
 */
export function mergeChunks(lists: PrefetchedChunk[][], limit: number): PrefetchedChunk[] {
  const keyOf = (c: PrefetchedChunk) => `${c.docId}\u0000${c.content}`;
  const best = new Map<string, PrefetchedChunk>();
  for (const list of lists) {
    for (const c of list) {
      const prev = best.get(keyOf(c));
      if (!prev || c.distance < prev.distance) best.set(keyOf(c), c);
    }
  }
  const picked = new Map<string, PrefetchedChunk>();
  for (const list of lists) {
    const top = [...list].sort((a, b) => a.distance - b.distance)[0];
    if (top && picked.size < limit) picked.set(keyOf(top), best.get(keyOf(top)) ?? top);
  }
  for (const c of [...best.values()].sort((a, b) => a.distance - b.distance)) {
    if (picked.size >= limit) break;
    if (!picked.has(keyOf(c))) picked.set(keyOf(c), c);
  }
  return [...picked.values()].sort((a, b) => a.distance - b.distance);
}

async function prefetchKnowledge(args: {
  agentId: string;
  apiKey: string;
  config: V2AgentConfig;
  themeId?: string;
  materialTitles?: string[];
  userMessage: string;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ query: string; chunks: PrefetchedChunk[] }> {
  const docIds = knowledgeDocIdsFor(args.config, activeTheme(args.config, args.themeId));
  const query = knowledgePrefetchQuery(args.userMessage, args.previousMessages);
  if (docIds.length === 0) {
    traceStep("base", "Sem materiais liberados para este agente/assunto — não buscou na base");
    return { query, chunks: [] };
  }
  if (!hasSearchableQuestion(query)) {
    traceStep("base", "Mensagem sem pergunta a buscar (saudação/curta) — não buscou na base");
    return { query, chunks: [] };
  }
  let rewrites: string[] = [];
  if (queryRewriteEnabled()) {
    try {
      rewrites = await rewriteKnowledgeQueries({
        model: args.config.model,
        apiKey: args.apiKey,
        userMessage: args.userMessage,
        previousMessages: args.previousMessages,
        materialTitles: args.materialTitles,
      });
      traceStep("base", rewrites.length > 0
        ? `Busca reformulada: ${rewrites.map((q) => `"${q}"`).join(", ")}`
        : "Reformulação não gerou consultas — busca só com a mensagem");
    } catch (err) {
      traceStep("base", `Reformulação da busca falhou (${err instanceof Error ? err.message : String(err)}) — busca só com a mensagem`);
    }
  }

  try {
    // Frase original + reformulações, em paralelo; fica o melhor de cada trecho.
    const queries = [query, ...rewrites.filter((q) => q.toLowerCase() !== query.toLowerCase())];
    const results = await Promise.all(
      queries.map((q) =>
        searchV2Knowledge({
          agentId: args.agentId,
          apiKey: args.apiKey,
          query: q,
          allowedDocIds: docIds,
          limit: PREFETCH_LIMIT,
        }).catch(() => undefined),
      ),
    );
    const chunks = mergeChunks(results.map((r) => r?.chunks ?? []), PREFETCH_LIMIT);
    traceStep("base", chunks.length > 0
      ? `Encontrou ${chunks.length} trecho(s): ${chunks.map((c) => `"${c.docTitle}" (${(1 - c.distance).toFixed(2)})`).join(", ")}`
      : `Nenhum trecho relevante em ${docIds.length} material(is)`,
      { queries });
    return { query: queries.join(" | "), chunks };
  } catch (err) {
    traceStep("base", `Falha ao buscar na base: ${err instanceof Error ? err.message : String(err)}`);
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
  /** Troca marcadores de dado sensível pelo valor real antes de executar. */
  restoreInput?: (input: unknown) => unknown;
}): { tools: ToolSet; governor: ToolCallGovernor } {
  const theme = activeTheme(args.config, args.themeId);
  const themeToolIds = themeToolRestriction(theme);
  const allowedDocIds = knowledgeDocIdsFor(args.config, theme);
  // A tela grava os modelos do assunto em `allowedMessageModelIds`;
  // `messageModelIds` é o nome legado. Lendo só o legado a restrição do
  // assunto era ignorada e valia a lista global.
  const allowedModelIds = allowedMessageModelIdsFor(args.config, theme);

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

  // Só as consultas de cada lista contam aqui: liberar uma ação (etiqueta,
  // tarefa) não pode desligar a busca nos materiais.
  const themeQueries = queryToolRestriction(themeToolIds);
  const globalQueries = queryToolRestriction(enabledToolNames);
  function isToolAllowed(toolName: string): boolean {
    if (themeQueries) return themeQueries.has(toolName);
    if (globalQueries) return globalQueries.has(toolName);
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
          const realInput = args.restoreInput ? args.restoreInput(input) : input;
          const result = capturedCtx
            ? await runWithContext(capturedCtx, () => execute(realInput))
            : await execute(realInput);
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
    async (input) => {
      const found = await searchV2Knowledge({
        agentId: args.agentId,
        apiKey: args.apiKey,
        query: input.query,
        allowedDocIds,
        limit: input.limit,
      });
      const tz = args.config.businessHours?.timezone || "America/Sao_Paulo";
      return { ...found, chunks: found.chunks.map((c) => ({ ...c, content: markPastDates(c.content, new Date(), tz) })) };
    },
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
    .catch(undefined)
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
  // Campo fora do formato vira o padrão em vez de invalidar a resposta
  // inteira: antes, um `"nome": null` em collected ou um sentimento fora da
  // lista mandava o turno para o fallback de erro (transferência).
  handoff: z.boolean().optional().default(false).catch(false),
  concluded: z.boolean().optional().default(false).catch(false),
  confirmed: z.boolean().nullable().optional().default(null).catch(null),
  outOfScope: z.boolean().optional().default(false).catch(false),
  sentiment: z.enum(["neutral", "dissatisfied", "angry"]).optional().default("neutral").catch("neutral"),
  tabulationId: z
    .union([z.string(), z.null()])
    .optional()
    .catch(undefined)
    .transform((v) => (typeof v === "string" ? v : undefined)),
  collected: z.preprocess(sanitizeCollected, z.record(z.string(), z.string())).optional().default({}),
  reason: z.string().optional().default("").catch(""),
  actions: z.preprocess(sanitizeActions, z.array(v2ActionSchema)).optional().default([]),
}) as unknown as z.ZodType<V2LLMOutput>;

/** Valores simples viram texto; vazio, lista ou objeto são descartados. */
function sanitizeCollected(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
    else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
  }
  return out;
}

/** Descarta ações sem tipo conhecido em vez de invalidar a resposta. */
function sanitizeActions(v: unknown): unknown[] {
  if (!Array.isArray(v)) return [];
  return v.filter((a) => v2ActionSchema.safeParse(a).success);
}

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

const MALFORMED_REASON = "LLM não retornou JSON válido — fallback de erro aplicado.";

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
    reason: MALFORMED_REASON,
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
  jsonMode?: boolean;
}): Promise<{
  output?: V2LLMOutput;
  inputTokens: number;
  outputTokens: number;
}> {
  const correctorSystem = [
    args.system,
    "",
    "# NORMALIZAÇÃO FINAL",
    "A resposta acima foi gerada em texto livre. Reescreva-a como um objeto JSON válido no formato exigido, sem alterar o conteúdo do 'reply'. Preencha os campos: handoff, concluded, confirmed, outOfScope, collected, reason, actions. Não inclua texto fora do JSON.",
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
      jsonMode: args.jsonMode,
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
  stage = "active",
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
    stage,
    themeId: theme?.id,
    themeInstructions: theme
      ? themePromptText(theme)
      : undefined,
    previousMessages,
  });
  return result;
}

function isBadRequest(err: unknown): boolean {
  const e = (err && typeof err === "object" ? err : {}) as { statusCode?: unknown; status?: unknown };
  return e.statusCode === 400 || e.status === 400;
}

/**
 * O que o agente não responde. Antes o escopo configurado nem chegava ao
 * prompt: o agente fazia conta e explicava programação no atendimento.
 */
export function scopeInstruction(config: V2AgentConfig): string {
  const lines = [
    "Você só atende o que é do atendimento desta empresa: os assuntos, materiais, calendário e dados do cliente listados abaixo.",
    "Não responda o que é de fora — contas e cálculos, conhecimentos gerais, programação, opiniões, dados internos da empresa (como número de clientes ou faturamento). Diga em uma frase, com gentileza, que aqui só pode ajudar com o atendimento e volte ao que o cliente precisa.",
    "Se a mensagem mistura as duas coisas, responda só a parte do atendimento e diga em meia frase que o resto não é com você. Mensagem só de fora: outOfScope=true.",
  ];
  const custom = config.scope?.message?.trim();
  if (custom) lines.push(`Para recusar, use esta mensagem: "${custom}"`);
  const forbidden = (config.scope?.forbidden ?? []).map((f) => f.subject).filter(Boolean);
  if (forbidden.length > 0) lines.push(`Assuntos que você não trata (transfira): ${forbidden.join("; ")}.`);
  return lines.join("\n");
}

/**
 * Mensagem que veio de áudio transcrito ou imagem lida automaticamente: a
 * transcrição pode errar. Com "confirmar entendimento" ligado, o agente
 * confirma o pedido quando ele está ambíguo; claro, responde direto.
 */
export function mediaUnderstandingNote(config: V2AgentConfig, userMessage: string): string {
  const fromMedia = /\[(Áudio do cliente, transcrito|Imagem enviada pelo cliente)/.test(userMessage);
  if (!fromMedia) return "";
  const confirm = config.media?.confirmUnderstanding !== false;
  return [
    "# Mídia do cliente",
    "Parte da mensagem do cliente veio de áudio transcrito ou de imagem lida automaticamente (marcada entre colchetes). Trate o conteúdo como o que o cliente disse ou mostrou.",
    confirm
      ? "A transcrição pode ter erros: se o pedido estiver ambíguo ou parecer cortado, confirme em uma frase o que entendeu antes de agir; se estiver claro, responda direto."
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * Data e hora atuais no fuso do agente. Sem isto o modelo não sabe o que é
 * "o próximo", "este mês" ou "ainda dá tempo" e, com as datas nos trechos,
 * mandava o cliente procurar a data sozinho.
 */
export function currentDateLine(timezone: string | undefined, now: Date = new Date()): string {
  const tz = timezone || "America/Sao_Paulo";
  let text: string;
  try {
    text = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(now);
  } catch {
    text = now.toISOString();
  }
  return `Agora é ${text} (${tz}). Use esta data para interpretar "hoje", "próximo(a)", "este mês" e prazos. Datas marcadas "(já passou)", nos trechos ou no calendário, já aconteceram: não as apresente como próximas e só cite se o cliente perguntar por elas. Se a data pedida não está no calendário nem nos trechos, diga que não tem essa data; não deduza.`;
}

/** Quanto emoji usar. Padrão "nenhum": era o comportamento antes do parâmetro. */
export function emojiInstruction(level: V2AgentConfig["emojis"]): string {
  switch (level) {
    case "light":
      return "Use poucos emojis (1 ou 2 por mensagem) para acolher ou destacar o principal, escolhidos conforme o conteúdo. Não use em reclamação, cobrança ou assunto delicado.";
    case "moderate":
      return "Use emojis para deixar a mensagem calorosa e fácil de ler, inclusive como marcadores de tópicos (por exemplo 📅 datas, 💰 valores, ✅ confirmações, 👉 próximo passo), até uns 4 por mensagem, variando conforme o conteúdo. Não use em reclamação, cobrança ou assunto delicado.";
    case "none":
    default:
      return "Não use emojis; tire emojis e marcadores decorativos do material.";
  }
}

function responseLengthToMaxTokens(length: V2AgentConfig["responseLength"]): number {
  // Rede de segurança com folga para a saída estruturada completa
  // (reply + theme + reason + actions). O controle real de tamanho vem
  // da instrução no system prompt.
  switch (length) {
    // 600 cortava por length um passo a passo completo (que não conta para
    // o limite de "curta") e a chamada era refeita com 2000.
    case "short":
      return 900;
    case "long":
      return 2000;
    case "medium":
    default:
      return 1000;
  }
}

// "Curta" antes dizia "curtas e diretas": o modelo cortava contexto e
// soava seco ("siga os passos que passei"). Tamanho é quanto explicar,
// nunca deixar de responder o que o cliente precisa.
function responseLengthInstruction(length: V2AgentConfig["responseLength"]): string {
  switch (length) {
    case "short":
      return "Respostas enxutas, mas completas: o que o cliente precisa saber ou fazer, sem rodeios, em frases naturais (ideal: até 2 parágrafos). Um passo a passo completo não conta para esse limite.";
    case "long":
      return "Pode responder com mais detalhes e explicações quando ajudarem o cliente: o porquê de cada passo, o que ele vai ver, o que fazer se algo der diferente.";
    case "medium":
    default:
      return "Responda de forma equilibrada: a informação ou o passo a passo completo, com uma ou duas frases de contexto quando ajudarem o cliente a entender o que fazer.";
  }
}

/**
 * Regras fixas de comportamento, uma vez cada. Antes estavam espalhadas em
 * sete lugares, algumas depois do exemplo de JSON, e se contradiziam sobre
 * o que fazer sem fonte (transferir, ignorar ou dizer que não tem).
 */
const SOURCES_GUIDE =
  "Responda com o que está nos trechos da base, no calendário, nos dados do cliente e nas informações fixas da empresa. Não complete com prazos, datas, valores, condições, canais, etapas nem nomes de menus, telas ou botões que não estejam nessas fontes, mesmo que pareçam óbvios. Não adivinhe com \"geralmente\" ou \"normalmente\": ou a fonte diz, ou você não sabe. Quando falta a informação, diga com naturalidade que não tem; marque handoff=true se o cliente precisa dela para seguir, se pediu uma pessoa ou se depende de outra pessoa. Não prometa verificar e retornar depois. Só diga que fez algo que esteja em actions.";

/** Como uma pessoa da equipe escreve numa conversa. Vale para qualquer produto. */
const WRITING_GUIDE = [
  "Escreva como uma pessoa experiente da equipe conversando por mensagem, não como um manual: frases completas e naturais, em primeira pessoa. Comece pelo que o cliente acabou de dizer; cumprimente pelo nome só no início da conversa.",
  "Responda primeiro exatamente o que foi perguntado. Se a fonte traz a informação (data, prazo, valor, regra), dê a informação em vez de dizer onde encontrá-la. Não peça desculpas sem motivo.",
  // O exemplo "peça que avise em qual passo travou" era copiado como fecho
  // até em resposta sem passo nenhum.
  "Termine com o próximo passo quando houver um: uma pergunta concreta ou o que fazer a seguir. Se já respondeu tudo, encerre sem fórmula de despedida.",
].join("\n");

const PROCEDURE_GUIDE =
  "Quando o cliente precisa fazer algo e a fonte traz um procedimento, entregue o passo a passo numerado, um passo por linha, com todos os passos na ordem da fonte, começando por como e onde acessar; se o procedimento está em mais de um trecho, junte na ordem certa. Listas (datas, opções, documentos) também vão um item por linha. Se o cliente diz que não entendeu, que está perdido ou pergunta por onde começar, recomece do primeiro passo com mais detalhe em vez de mandá-lo reler as mensagens anteriores.";

/**
 * Ordem: quem é o agente e como responde no topo, dados no meio, formato
 * de saída por último. Antes as regras de fonte vinham depois do exemplo
 * de JSON e o modelo as lia como nota de rodapé.
 */
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
  messageModels: V2MessageModelSummary[] = [],
  mediaNote = "",
  actionStages: Array<{ id: string; name: string }> = [],
): string {
  const timezone = config.businessHours?.timezone || "America/Sao_Paulo";
  const lines: string[] = [];
  lines.push(`# Tom de voz\n${config.tone}`);
  if (config.globalRules.length > 0) lines.push(`# Regras globais\n${config.globalRules.join("\n")}`);
  lines.push(`# Escopo\n${scopeInstruction(config)}`);
  lines.push(`# Fontes\n${SOURCES_GUIDE}`);
  lines.push(`# Como escrever\n${WRITING_GUIDE}`);
  lines.push(`# Procedimentos e listas\n${PROCEDURE_GUIDE}`);
  lines.push(`# Tamanho das respostas\n${responseLengthInstruction(config.responseLength)}`);
  lines.push(`# Emojis\n${emojiInstruction(config.emojis)}`);
  lines.push(`# Data de hoje\n${currentDateLine(config.businessHours?.timezone)}`);
  if (mediaNote) lines.push(mediaNote);
  if (stage === "confirming") {
    lines.push("# Confirmação de identidade\nVocê está confirmando a identidade do cliente. Se ele confirmar que é ele, devolva confirmed: true. Se negar ou pedir para falar de outra pessoa, confirmed: false. Se a resposta for irrelevante, confirmed: null. Se ele confirmar e, antes da confirmação, já tinha feito um pedido que ficou sem resposta (veja as mensagens anteriores), responda esse pedido agora, na mesma mensagem, em vez de perguntar como pode ajudar.");
  }

  // Dados que o modelo pode usar para entender a situação.
  lines.push("# Dados do cliente para consulta interna");
  const hasReadableContact = context.contact && Object.keys(context.contact).length > 0;
  const hasReadableDeal = context.selectedDeal && Object.keys(context.selectedDeal).length > 0;
  if (hasReadableContact) {
    lines.push(`Contato: ${JSON.stringify(context.contact)}`);
  }
  if (hasReadableDeal) {
    lines.push(`Negócio: ${JSON.stringify(context.selectedDeal)}`);
  } else if (hasReadableContact) {
    lines.push("Negócio: nenhum encontrado.");
  }
  if (!hasReadableContact && !hasReadableDeal) {
    lines.push("Nenhum contato encontrado para esta conversa. Não comente isso com o cliente.");
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
  // A regra só faz sentido quando há campo de consulta que não é citável.
  const hiddenFields = (full: Record<string, unknown> | null | undefined, cite: Record<string, unknown> | null | undefined) =>
    Object.keys(full ?? {}).some((k) => !(k in (cite ?? {})));
  if (hiddenFields(context.contact, citableContact) || hiddenFields(context.selectedDeal, citableDeal)) {
    lines.push("Regra de citação: só escreva/repita para o cliente os campos listados em 'Dados que você pode citar na resposta'. Os demais servem apenas para você entender a situação.");
  }

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
    lines.push(`# Assunto ativo: ${themeId}`);
    lines.push(themeInstructions);
  }

  if (collectedVariables && Object.keys(collectedVariables).length > 0) {
    lines.push("# Variáveis já coletadas nesta conversa");
    lines.push(JSON.stringify(collectedVariables));
  }

  const calendar = calendarPromptSection(config.calendar?.events, new Date(), timezone);
  if (calendar) lines.push(calendar);

  if (prefetchedChunks.length > 0) {
    lines.push("# Trechos da base de conhecimento relacionados à mensagem");
    lines.push("Já buscados pelo significado da mensagem. Use os que atendem ao pedido; ignore os outros sem mencioná-los.");
    prefetchedChunks.forEach((c, i) => {
      const raw = c.content.length > PREFETCH_CHUNK_CHARS ? `${c.content.slice(0, PREFETCH_CHUNK_CHARS)}…` : c.content;
      const body = markPastDates(raw, new Date(), timezone);
      lines.push(`[${i + 1}] ${c.docTitle}\n${body}`);
    });
  }
  if (messageModels.length > 0) {
    lines.push("# Mensagens prontas que você pode enviar");
    lines.push("Para enviar uma, devolva messageModel: { \"id\": \"<id>\" }. Ela chega ao cliente depois da sua reply, com os anexos (imagem, vídeo, áudio, documento). Use quando a mensagem pronta atende ao que o cliente pediu — principalmente quando ele precisa ver algo. Ao usar, a reply deve ser só uma frase curta de introdução: não repita o conteúdo da mensagem pronta nem descreva o anexo.");
    for (const m of messageModels) {
      lines.push(`- ${m.id}: ${m.name}${m.mediaKinds.length > 0 ? ` (inclui ${[...new Set(m.mediaKinds)].join(", ")})` : ""}`);
    }
  }

  const availableTools = QUERY_TOOL_NAMES.filter((t) => (allowedToolNames ?? []).includes(t));
  if (availableTools.length > 0) {
    lines.push("# Ferramentas de consulta");
    lines.push(`Antes de responder, você pode chamar: ${availableTools.join(", ")}. Não chame a mesma ferramenta com os mesmos argumentos mais de uma vez.`);
    const promptDocIds = knowledgeDocIdsFor(config, activeTheme(config, themeId));
    if (availableTools.includes("knowledge_search") && promptDocIds.length > 0) {
      // Com a pré-busca, "chame knowledge_search primeiro" gerava uma
      // segunda busca igual a cada turno.
      lines.push(prefetchedChunks.length > 0
        ? "Os trechos acima já vieram da base; chame knowledge_search só para buscar outra informação que eles não trazem."
        : "Quando a pergunta puder ser respondida pelos materiais, chame knowledge_search antes de responder.");
      if (knowledgeDocTitles && knowledgeDocTitles.length > 0) {
        lines.push(`Materiais disponíveis: ${knowledgeDocTitles.join("; ")}.`);
      }
    }
  }

  const actions = actionsGuide(allowedActionTypes(config, activeTheme(config, themeId)), {
    tags: config.actionOptions?.tags ?? [],
    stages: actionStages,
  });
  if (actions) lines.push(actions);

  lines.push("# Saída");
  lines.push("Responda só com um objeto JSON válido neste formato, sem texto fora dele:");
  // Sem placeholders: o modelo copiava "id do tema (opcional)" e
  // { "campo": "valor" } para a saída. Antes, `actions: [{ type: "handoff" }]`
  // no exemplo fazia pedir transferência sem motivo.
  const offerTheme = !themeId && config.themes.length > 0;
  lines.push(JSON.stringify({
    reply: "texto para o cliente",
    ...(offerTheme ? { theme: null } : {}),
    messageModel: null,
    handoff: false,
    concluded: false,
    confirmed: null,
    outOfScope: false,
    collected: {},
    reason: "uma frase sobre a decisão",
    actions: [],
  }));
  lines.push([
    "- handoff: true só quando precisa de uma pessoa (ver Fontes).",
    "- actions: ações deste turno; vazia quando não há.",
    "- messageModel: null ou { id: string, adapt?: boolean, variables?: {chave: valor} }. Nunca um objeto vazio.",
    "- collected: dados que o cliente informou neste turno; vazio se nenhum.",
    "- concluded: true quando o atendimento terminou.",
    ...(offerTheme ? [`- theme: id do assunto que melhor descreve o pedido (${config.themes.map((t) => t.id).join(", ")}) ou null.`] : []),
  ].join("\n"));

  return lines.join("\n\n");
}

/** Nome das etapas liberadas para "mover etapa" (funil › etapa). */
async function actionStageNames(config: V2AgentConfig, theme: ReturnType<typeof activeTheme>): Promise<Array<{ id: string; name: string }>> {
  const ids = config.actionOptions?.stageIds ?? [];
  if (ids.length === 0 || !allowedActionTypes(config, theme).has("move_stage")) return [];
  try {
    // Import tardio: o prompt não precisa do banco quando não há etapas.
    const { prisma } = await import("@/lib/prisma");
    const rows: Array<{ id: string; name: string; pipeline?: { name: string } | null }> = await (prisma as any).stage.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, pipeline: { select: { name: true } } },
    });
    return rows.map((r) => ({ id: r.id, name: r.pipeline?.name ? `${r.pipeline.name} › ${r.name}` : r.name }));
  } catch (err) {
    console.warn("[ai-v2] Erro ao carregar as etapas das ações:", err instanceof Error ? err.message : err);
    return [];
  }
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
  // Documento e e-mail digitados pelo cliente vão ao modelo como marcador
  // ("[CPF 1]"); senha e cartão são removidos. O valor real só volta onde
  // precisa (ferramenta, variável coletada, ação).
  const vault = new SensitiveVault();
  const userMessage = vault.tokenize(args.userMessage);
  const previousMessages = (args.previousMessages ?? []).map((m) => ({ ...m, content: vault.tokenize(m.content) }));
  if (vault.kinds.size > 0) {
    traceStep("dados sensíveis", `Mascarado antes do modelo: ${[...vault.kinds].join(", ")}`);
  }
  const { tools, governor } = buildV2ToolSet({
    config: args.config,
    context: args.context,
    agentId: args.agentId,
    apiKey,
    themeId: args.themeId,
    restoreInput: vault.size > 0 ? (input) => vault.restoreDeep(input) : undefined,
  });
  const allowedToolNames = Object.keys(tools);

  // Carrega os títulos dos materiais permitidos para ajudar o modelo a
  // decidir quando chamar knowledge_search e a contextualizar a resposta.
  const promptTheme = activeTheme(args.config, args.themeId);
  const promptDocIds = knowledgeDocIdsFor(args.config, promptTheme);
  let knowledgeDocTitles: string[] = [];
  if (promptDocIds.length > 0) {
    try {
      knowledgeDocTitles = await knowledgeDocTitlesByIds(args.agentId, promptDocIds);
    } catch (err) {
      console.warn("[ai-v2] Erro ao carregar títulos dos materiais:", err instanceof Error ? err.message : err);
    }
  }

  // Mensagens prontas liberadas (assunto, senão globais) com o tipo de mídia.
  const modelIds = allowedMessageModelIdsFor(args.config, promptTheme);
  const messageModels = await describeV2MessageModels(modelIds).catch((err) => {
    console.warn("[ai-v2] Erro ao carregar mensagens prontas:", err instanceof Error ? err.message : err);
    return [] as V2MessageModelSummary[];
  });

  const actionStages = await actionStageNames(args.config, promptTheme);

  const prefetch = await prefetchKnowledge({
    agentId: args.agentId,
    apiKey,
    config: args.config,
    themeId: args.themeId,
    materialTitles: knowledgeDocTitles,
    userMessage,
    previousMessages,
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
    messageModels,
    mediaUnderstandingNote(args.config, userMessage),
    actionStages,
  );

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...previousMessages,
    { role: "user", content: userMessage },
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

  let jsonMode = args.config.structuredOutput === true;

  async function attempt(): Promise<{
    output: V2LLMOutput;
    inputTokens: number;
    outputTokens: number;
    toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>;
    wasExpanded?: boolean;
  }> {
    const generate = async (maxOutputTokens: number) => {
      const call = (json: boolean) =>
        generateWithTools({
          model: args.config.model,
          apiKey,
          system,
          messages: messages as any,
          tools,
          temperature: behaviorToTemperature(args.config.responseBehavior),
          maxOutputTokens,
          maxSteps: hasTools ? (args.config.toolGovernor?.maxCallsPerTurn ?? 6) + 1 : 1,
          jsonMode: json,
        });
      if (!jsonMode) return call(false);
      try {
        return await call(true);
      } catch (err) {
        // Modelo sem suporte ao modo JSON: segue pelo caminho de antes
        // (formato pedido só no prompt) em vez de deixar o cliente sem resposta.
        if (!isBadRequest(err)) throw err;
        jsonMode = false;
        traceStep("llm", `Modo JSON recusado pelo modelo ${args.config.model} — seguindo sem ele`);
        return call(false);
      }
    };

    let result = await generate(responseLengthToMaxTokens(args.config.responseLength));

    // Se o modelo cortou por limite de tokens, tenta novamente com a rede de
    // segurança mais ampla (long) em vez de devolver JSON quebrado.
    let wasExpanded = false;
    if (result.finishReason === "length") {
      wasExpanded = true;
      console.warn("[ai-v2] LLM resposta cortada por length; expandindo maxOutputTokens");
      result = await generate(responseLengthToMaxTokens("long"));
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
        jsonMode,
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
    output.reply = breakInlineSteps(renderMessage(output.reply, renderVars) ?? output.reply);

    return {
      output,
      inputTokens: result.inputTokens + correctorTokens.input,
      outputTokens: result.outputTokens + correctorTokens.output,
      toolCalls: result.toolCalls,
      wasExpanded,
    };
  }

  /**
   * Nome de menu/botão/tela entre aspas que não está em nenhuma fonte:
   * pede uma reescrita só com o material. Se ainda inventar, transfere.
   */
  async function checkQuotedTerms(r: Awaited<ReturnType<typeof attempt>>): Promise<void> {
    // Só o que é fonte de verdade. Com o prompt inteiro (guias, lista de
    // títulos de todos os materiais) qualquer palavra comum, como
    // "Documentos" ou "Solicitações", passava como se tivesse fonte.
    const sources = [
      userMessage,
      ...previousMessages.map((m) => m.content),
      ...prefetch.chunks.flatMap((c) => [c.docTitle, c.content]),
      ...knowledgeChunkTexts(r.toolCalls),
      args.themeInstructions ?? "",
      ...args.config.globalRules,
      ...args.config.variables.map((v) => `${v.key}: ${v.value}`),
      ...(args.config.calendar?.events ?? []).map((e) => e.title),
      ...messageModels.map((m) => m.name),
      JSON.stringify([args.context.contact, args.context.selectedDeal, args.context.citableContact, args.context.citableDeal]),
    ];
    const unsupportedOf = (reply: string) => [
      ...unsupportedQuotedTerms(reply, sources).map((t) => `"${t}"`),
      ...unsupportedFigures(reply, sources),
      ...unsupportedHedges(reply, sources).map((h) => `"${h}" (palpite sem fonte)`),
    ];
    const unsupported = unsupportedOf(r.output.reply);
    if (unsupported.length === 0) return;
    const list = unsupported.join(", ");
    traceStep("verificação", `Resposta cita ${list}, que não está no material nem na conversa — pedindo reescrita`);
    const reviewSystem = [
      system,
      "# REVISÃO",
      `Sua resposta anterior cita ${list}, que não aparece nos trechos da base, nas instruções nem na conversa. Reescreva a resposta usando só nomes, passos e caminhos que estão nos trechos. Se os trechos não dizem como fazer o que o cliente pediu, diga isso com naturalidade e marque handoff=true. Devolva o JSON completo no formato exigido.`,
    ].join("\n\n");
    try {
      const res = await generateWithTools({
        model: args.config.model,
        apiKey,
        system: reviewSystem,
        messages: [...messages, { role: "assistant", content: JSON.stringify(r.output) }] as any,
        temperature: 0,
        maxOutputTokens: responseLengthToMaxTokens(args.config.responseLength),
        maxSteps: 1,
        jsonMode,
      });
      r.inputTokens += res.inputTokens;
      r.outputTokens += res.outputTokens;
      const raw = res.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const json = extractFirstJSONObject(raw);
      const parsed = json ? v2LLMOutputSchema.safeParse(JSON.parse(json)) : undefined;
      if (parsed?.success) {
        const fixed = parsed.data as V2LLMOutput;
        fixed.reply = renderMessage(fixed.reply, renderVars) ?? fixed.reply;
        const still = unsupportedOf(fixed.reply);
        if (still.length === 0) {
          traceStep("verificação", "Reescrita só com o material");
          r.output = fixed;
          return;
        }
      }
    } catch (err) {
      console.warn("[ai-v2] revisão de termos falhou:", err instanceof Error ? err.message : err);
    }
    traceStep("verificação", "A reescrita ainda cita o que não está no material — transferindo");
    r.output = {
      ...r.output,
      reply: args.config.fallback?.noSource?.message || args.config.handoff?.message || "Vou chamar uma pessoa da equipe para te ajudar com isso.",
      handoff: true,
      actions: [...r.output.actions.filter((a) => a.type !== "handoff"), { type: "handoff" }],
      reason: `Citava ${list}, que não está no material.`,
    };
  }

  /**
   * Resposta quase igual à anterior: o envio a barraria e o cliente, que
   * mandou "?" ou insistiu, ficava sem nada. Reescreve de outro jeito.
   */
  async function avoidRepeat(r: Awaited<ReturnType<typeof attempt>>): Promise<void> {
    const last = [...previousMessages].reverse().find((m) => m.role === "assistant")?.content;
    if (!last || r.output.handoff || !isNearDuplicateReply(r.output.reply, last)) return;
    traceStep("verificação", "Resposta repetiria a anterior — pedindo outra forma");
    const reviewSystem = [
      system,
      "# REVISÃO",
      "Sua resposta repete quase igual a mensagem anterior, e o cliente não deve receber a mesma mensagem de novo. Se ele mostrou dúvida (\"?\", \"não entendi\"), explique de outro jeito, mais simples, ou pergunte o que ficou confuso. Se só confirmou ou agradeceu, responda curto. Não copie o texto anterior. Devolva o JSON completo no formato exigido.",
    ].join("\n\n");
    try {
      const res = await generateWithTools({
        model: args.config.model,
        apiKey,
        system: reviewSystem,
        messages: messages as any,
        temperature: 0.7,
        maxOutputTokens: responseLengthToMaxTokens(args.config.responseLength),
        maxSteps: 1,
        jsonMode,
      });
      r.inputTokens += res.inputTokens;
      r.outputTokens += res.outputTokens;
      const raw = res.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const json = extractFirstJSONObject(raw);
      const parsed = json ? v2LLMOutputSchema.safeParse(JSON.parse(json)) : undefined;
      if (parsed?.success && !isNearDuplicateReply(parsed.data.reply, last)) {
        const fixed = parsed.data as V2LLMOutput;
        fixed.reply = breakInlineSteps(renderMessage(fixed.reply, renderVars) ?? fixed.reply);
        r.output = fixed;
        return;
      }
    } catch (err) {
      console.warn("[ai-v2] reescrita de repetição falhou:", err instanceof Error ? err.message : err);
    }
    r.output = { ...r.output, reply: "Ficou alguma dúvida sobre o que te passei? Me conta o que não ficou claro que eu explico de outro jeito." };
  }

  let lastError: Error | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await attempt();
      // Saída ilegível virava transferência na primeira vez (um "oi" chegou
      // a transferir). Tenta de novo antes de cair no fallback.
      if (r.output.reason === MALFORMED_REASON && i === 0) {
        traceStep("verificação", "O modelo devolveu um formato ilegível — tentando de novo");
        continue;
      }
      await checkQuotedTerms(r);
      await avoidRepeat(r);
      if (vault.size > 0) {
        r.output.collected = vault.restoreDeep(r.output.collected);
        r.output.actions = vault.restoreDeep(r.output.actions);
        r.output.reply = vault.display(r.output.reply);
      }
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
