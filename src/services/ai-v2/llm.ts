/**
 * Chamada ao LLM para o motor v2.
 * Gera JSON estruturado e valida com Zod; faz 1 retry se inválido.
 * Nenhum domínio de cliente.
 */

import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey, getAgentChatKey } from "@/services/ai/agent-key";
import { v2AuxModel, v2FastAuxModel } from "@/lib/ai-v2/models";
import { answersBeforeHandoff, statesProcedure } from "./no-source";
import { businessHoursText } from "./rules";
import { getRequestContext, runWithContext } from "@/lib/request-context";
import { behaviorToTemperature } from "@/lib/ai-v2/response-behavior";
import { messageModelModeFor, messageModelPromptRule } from "@/lib/ai-v2/message-model-mode";
import { sharedContentWords } from "./sent-materials";
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
  knowledgeChunksContaining,
} from "./tools";
import { knowledgeDocTitleMapByIds } from "@/services/ai/knowledge-docs";
import { describeV2MessageModels, type V2MessageModelSummary } from "./tools";
import { knowledgeDocIdsFor } from "./themes";
import { clientNamesBoundToFacts, hasSearchableQuestion, admittedMissingInstructions, isNearDuplicateReply, repeatFallback, knowledgeChunkTexts, lookupResultTexts, unsupportedFacts, unsupportedFigures, unsupportedHedges, unsupportedMenuPaths, unsupportedQuotedTerms } from "./ground-reply";
import { noteV2Fact, traceStep } from "./trace";
import { SensitiveVault } from "./sensitive";
import { boldInstruction, breakInlineSteps } from "./reply-format";
import { markPastDates, tenseMismatches } from "./dates";
import { calendarPromptSection } from "./calendar";
import { QUERY_TOOL_NAMES, themePromptText } from "./theme-prompt";
import { REPLY_ENDING_PROMPT, effectiveReplyEnding, hasReplyEnding } from "./reply-ending";
import { CONFUSION_PROMPT } from "./confusion";
import { MAIN_SOURCE_SIMILARITY, WEAK_MATCH_SIMILARITY, knowledgeMinSimilarity } from "./similarity-presets";
import { checkClaimsWithModel, sameClaim, worthClaimCheck } from "./claim-check";
import { isMutilated, onlyKeptSentences, trimUnsupportedSentences } from "./reply-trim";
import { MATERIAL_ATTACHMENT_LIMITS, attachmentsForDocs, attachmentsPromptSection } from "./material-attachments";
import { humanRequestTerms } from "@/lib/ai-v2/config";
import { actionsGuide, allowedActionTypes, allowedFlowIdsFor, allowedMessageModelIdsFor, queryToolRestriction, repairMessageModelId, themeToolRestriction } from "./action-policy";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai-v2.llm");

type PrefetchedChunk = { docId: string; docTitle: string; content: string; distance: number; priority?: boolean };
/** Trecho do material do assunto vai inteiro (o comum é cortado em PREFETCH_CHUNK_CHARS). */
const PRIORITY_CHUNK_CHARS = 6000;
const PRIORITY_LIMIT = 2;

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

/**
 * Prazo da reformulação da busca: numa sessão real ela levou 31 s. Passado o
 * prazo, busca só com a frase original (que já está buscando em paralelo).
 */
const REWRITE_TIMEOUT_MS = 3500;
/** Trecho tão parecido com a pergunta que a reformulação não acrescenta. */
const DIRECT_SEARCH_ENOUGH = 0.65;

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tempo esgotado (${Math.round(ms / 1000)} s)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const foldTitle = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Materiais que entram primeiro, com o conteúdo inteiro: os vinculados ao
 * assunto escolhido e os cujo título casa com a busca. Pela nota de
 * embedding o material do próprio assunto ficava atrás de um vizinho
 * (0,47 contra 0,61) e cada rodada partia de uma base diferente.
 */
export function priorityDocIds(args: {
  theme: { allowedKnowledgeDocIds?: string[]; knowledgeDocIds?: string[] } | null | undefined;
  allowedDocIds: string[];
  titles: Map<string, string>;
  queries: string[];
}): string[] {
  const allowed = new Set(args.allowedDocIds);
  const out: string[] = [];
  for (const id of [...(args.theme?.allowedKnowledgeDocIds ?? []), ...(args.theme?.knowledgeDocIds ?? [])]) {
    if (allowed.has(id) && !out.includes(id)) out.push(id);
  }
  const folded = args.queries.map(foldTitle).filter(Boolean);
  for (const [id, title] of args.titles) {
    const t = foldTitle(title);
    if (!t || t.length < 6 || !allowed.has(id) || out.includes(id)) continue;
    if (folded.some((q) => q === t || q.includes(t) || (t.includes(q) && q.length >= 12))) out.push(id);
  }
  return out.slice(0, 3);
}

async function prefetchKnowledge(args: {
  agentId: string;
  apiKey: string;
  config: V2AgentConfig;
  themeId?: string;
  materialTitles?: string[];
  /** id → título dos materiais liberados (para o material do assunto entrar primeiro). */
  docTitles?: Map<string, string>;
  userMessage: string;
  previousMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ query: string; chunks: PrefetchedChunk[]; searched: boolean; best: number | null }> {
  const theme = activeTheme(args.config, args.themeId);
  const docIds = knowledgeDocIdsFor(args.config, theme);
  const query = knowledgePrefetchQuery(args.userMessage, args.previousMessages);
  if (docIds.length === 0) {
    traceStep("base", "Sem materiais liberados para este agente/assunto — não buscou na base");
    noteV2Fact("prefetch", { searchable: hasSearchableQuestion(query), searched: false, reason: "no_docs", docCount: 0, queries: [], found: 0 });
    return { query, chunks: [], searched: false, best: null };
  }
  if (!hasSearchableQuestion(query)) {
    traceStep("base", "Mensagem sem pergunta a buscar (saudação/curta) — não buscou na base");
    noteV2Fact("prefetch", { searchable: false, searched: false, reason: "not_a_question", docCount: docIds.length, queries: [], found: 0 });
    return { query, chunks: [], searched: false, best: null };
  }
  const search = (q: string) =>
    searchV2Knowledge({
      agentId: args.agentId,
      apiKey: args.apiKey,
      query: q,
      allowedDocIds: docIds,
      limit: PREFETCH_LIMIT,
      minSimilarity: knowledgeMinSimilarity(args.config),
    }).catch(() => undefined);
  // A frase original já busca enquanto a reformulação roda (antes esperava).
  const original = search(query);
  let rewrites: string[] = [];
  if (queryRewriteEnabled()) {
    const rewriting = withTimeout(REWRITE_TIMEOUT_MS, rewriteKnowledgeQueries({
      // Tarefa auxiliar: na OpenAI, com a chave de busca do agente.
      model: v2FastAuxModel(args.config.model),
      apiKey: args.apiKey,
      userMessage: args.userMessage,
      previousMessages: args.previousMessages,
      materialTitles: args.materialTitles,
    }));
    rewriting.catch(() => undefined);
    // A frase original já achou um trecho forte: não espera a reformulação.
    const direct = await original;
    const directBest = direct?.chunks.length ? Math.max(...direct.chunks.map((c) => 1 - c.distance)) : 0;
    // Pergunta curta ("Primeiro acesso") ou trecho só razoável: a
    // reformulação acha o material certo; com 0,50 ela era pulada e a
    // resposta saía de um material vizinho.
    const shortQuestion = args.userMessage.trim().split(/\s+/).length <= 3;
    if (!shortQuestion && directBest >= DIRECT_SEARCH_ENOUGH) {
      traceStep("base", `A busca direta já achou trecho forte (${directBest.toFixed(2)}) — sem esperar a reformulação`);
    } else {
      try {
        rewrites = await rewriting;
        traceStep("base", rewrites.length > 0
          ? `Busca reformulada: ${rewrites.map((q) => `"${q}"`).join(", ")}`
          : "Reformulação não gerou consultas — busca só com a mensagem");
      } catch (err) {
        traceStep("base", `Reformulação da busca falhou (${err instanceof Error ? err.message : String(err)}) — busca só com a mensagem`);
      }
    }
  }

  try {
    // Frase original + reformulações, em paralelo; fica o melhor de cada trecho.
    const extra = rewrites.filter((q) => q.toLowerCase() !== query.toLowerCase());
    const queries = [query, ...extra];
    // Material do assunto (ou cujo título casa com a busca): os melhores
    // trechos dele entram primeiro, sem depender da nota mínima.
    const priority = priorityDocIds({ theme, allowedDocIds: docIds, titles: args.docTitles ?? new Map(), queries });
    const priorityQuery = queries.find((q) => [...(args.docTitles ?? new Map<string, string>()).entries()].some(([id, t]) => priority.includes(id) && foldTitle(q) === foldTitle(t))) ?? query;
    const prioritySearch = priority.length > 0
      ? searchV2Knowledge({ agentId: args.agentId, apiKey: args.apiKey, query: priorityQuery, allowedDocIds: priority, limit: PRIORITY_LIMIT, minSimilarity: 0 }).catch(() => undefined)
      : Promise.resolve(undefined);
    const [priorityResult, ...results] = await Promise.all([prioritySearch, original, ...extra.map(search)]);
    const priorityChunks: PrefetchedChunk[] = (priorityResult?.chunks ?? []).slice(0, PRIORITY_LIMIT).map((c) => ({ ...c, priority: true }));
    const keyOf = (c: PrefetchedChunk) => `${c.docId}\u0000${c.content}`;
    const taken = new Set(priorityChunks.map(keyOf));
    const others = mergeChunks(results.map((r) => r?.chunks ?? []), PREFETCH_LIMIT).filter((c) => !taken.has(keyOf(c)));
    const chunks = [...priorityChunks, ...others];
    if (priorityChunks.length > 0) traceStep("base", `Material do assunto primeiro, inteiro: ${[...new Set(priorityChunks.map((c) => `"${c.docTitle}"`))].join(", ")}`);
    traceStep("base", chunks.length > 0
      ? `Encontrou ${chunks.length} trecho(s): ${chunks.map((c) => `"${c.docTitle}" (${(1 - c.distance).toFixed(2)}${c.priority ? ", assunto" : ""})`).join(", ")}`
      : `Nenhum trecho relevante em ${docIds.length} material(is)`,
      { queries });
    noteV2Fact("prefetch", {
      searchable: true,
      searched: true,
      docCount: docIds.length,
      queries,
      found: chunks.length,
      bestSimilarity: chunks.length > 0 ? Math.max(...chunks.map((c) => 1 - c.distance)) : null,
      docIds: [...new Set(chunks.map((c) => c.docId).filter(Boolean))],
      // O modelo lê só o começo de cada trecho (PREFETCH_CHUNK_CHARS); o do assunto vai inteiro.
      truncatedDocIds: [...new Set(chunks.filter((c) => c.content.length > (c.priority ? PRIORITY_CHUNK_CHARS : PREFETCH_CHUNK_CHARS)).map((c) => c.docId).filter(Boolean))],
    });
    return {
      query: queries.join(" | "),
      chunks,
      searched: true,
      best: chunks.length > 0 ? Math.max(...chunks.map((c) => 1 - c.distance)) : null,
    };
  } catch (err) {
    traceStep("base", `Falha ao buscar na base: ${err instanceof Error ? err.message : String(err)}`);
    noteV2Fact("prefetch", { searchable: true, searched: false, reason: "error", docCount: docIds.length, queries: [query], found: 0 });
    log.warn({ err: err instanceof Error ? err.message : err }, "[ai-v2] pré-busca na base falhou");
    return { query, chunks: [], searched: false, best: null };
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
    "send_whatsapp_flow",
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
          // O erro volta ao modelo e vai para o log: sem ids internos. O
          // contexto (tinha ou não organização) fica só no log do servidor.
          log.warn(
            {
              toolName,
              ctxNaMontagem: Boolean(capturedCtx),
              ctxNaFalha: Boolean(getRequestContext()),
              err: msg,
            },
            "[ai-v2] ferramenta falhou",
          );
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

  // Chaves que a config libera para leitura — a tool não devolve nada além.
  const crmReadableKeys = [
    ...args.context.fields.contact
      .filter((f) => f.permissions.includes("read") || f.permissions.includes("cite"))
      .map((f) => `contact.${f.key}`),
    ...args.context.fields.deal
      .filter((f) => f.permissions.includes("read") || f.permissions.includes("cite"))
      .map((f) => `deal.${f.key}`),
  ];
  // Cliente com um negócio só (ou nenhum): o cadastro e o negócio já estão no
  // contexto e a consulta devolveria o mesmo. Oferecida, o modelo consultava a
  // cada mensagem com termos soltos e somava uma ida e volta (segundos).
  const crmAlreadyInContext = (args.context.deals?.length ?? 0) <= 1;
  const searchCrm = crmAlreadyInContext ? undefined : wrapTool(
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
        masks: Object.fromEntries([
          ...args.config.contextFields.contact.filter((f) => f.mask && f.mask !== "none").map((f) => [`contact.${f.key}`, f.mask!]),
          ...args.config.contextFields.deal.filter((f) => f.mask && f.mask !== "none").map((f) => [`deal.${f.key}`, f.mask!]),
        ]),
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
        minSimilarity: knowledgeMinSimilarity(args.config),
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
  flow: z
    .union([
      z.object({
        id: z.unknown().transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null)),
      }),
      z.null(),
    ])
    .optional()
    .transform((v) => {
      if (!v || typeof v !== "object" || v === null) return undefined;
      const id = (v as { id?: string | null }).id;
      if (!id || typeof id !== "string") return undefined;
      return { id };
    }),
  attachments: z
    .unknown()
    .optional()
    .transform((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined)),
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
  log.warn(
    { textLength: rawText.length },
    "[ai-v2] LLM não retornou JSON válido. Fallback de erro aplicado.",
  );
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
  log.warn(
    { textLength: cleaned.length },
    "[ai-v2] LLM não devolveu JSON válido. Usando texto livre como reply.",
  );
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
    log.warn({ err: msg }, "[ai-v2] Falha na normalização de JSON");
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
  opts: { humanRequestWithQuestion?: boolean } = {},
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
    humanRequestWithQuestion: opts.humanRequestWithQuestion === true,
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
  return `Agora é ${text} (${tz}). Use esta data para interpretar "hoje", "próximo(a)", "este mês" e prazos. Datas marcadas "(já passou)", nos trechos ou no calendário, já aconteceram: não as apresente como próximas e só cite se o cliente perguntar por elas. Data depois de hoje ainda vai acontecer: fale dela no futuro ("será", "acontece em"), nunca como já realizada. Se a data pedida não está no calendário nem nos trechos, diga que não tem essa data; não deduza.`;
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
  "Responda com o que está nos trechos da base, no calendário, nos dados do cliente e nas informações fixas da empresa. Não complete com prazos, datas, valores, condições, canais, etapas nem nomes de menus, telas ou botões que não estejam nessas fontes, mesmo que pareçam óbvios. Não adivinhe com \"geralmente\" ou \"normalmente\": ou a fonte diz, ou você não sabe. Nome específico que o cliente citou (produto, plano, serviço, item) e que não aparece nas fontes nem nos dados dele: não confirme que existe nem atribua a ele datas, valores ou regras próprias; dê a regra geral e diga que não consegue confirmar esse item. Passo a passo só se um trecho descreve esse procedimento: não monte um caminho geral a partir do procedimento de outro serviço nem do que aparece numa imagem. Quando falta a informação, diga com naturalidade que não tem; marque handoff=true se o cliente precisa dela para seguir, se pediu uma pessoa ou se depende de outra pessoa. Não prometa verificar e retornar depois. Só diga que fez algo que esteja em actions.";

/** Como uma pessoa da equipe escreve numa conversa. Vale para qualquer produto. */
const WRITING_GUIDE = [
  "Escreva como uma pessoa experiente da equipe conversando por mensagem, não como um manual: frases completas e naturais, em primeira pessoa. Comece pelo que o cliente acabou de dizer; cumprimente pelo nome só no início da conversa.",
  "Responda primeiro exatamente o que foi perguntado. Se a fonte traz a informação (data, prazo, valor, regra), dê a informação em vez de dizer onde encontrá-la. Não peça desculpas sem motivo.",
  // "A base não informa…" chegava ao cliente: jargão interno do agente.
  "Nunca fale com o cliente sobre \"base\", \"material\", \"trechos\", \"fontes\" ou \"instruções\": quando falta a informação, diga com naturalidade que não tem essa informação.",
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
  nothingRelevant = false,
  attachmentsSection = "",
  humanRequestWithQuestion = false,
  flows: Array<{ id: string; name: string }> = [],
  priorSummary: { text: string; at?: Date | null; agent?: string | null; current?: boolean } | null = null,
  transparentTransfer = false,
): string {
  const timezone = config.businessHours?.timezone || "America/Sao_Paulo";
  const lines: string[] = [];
  lines.push(`# Tom de voz\n${config.tone}`);
  if (config.globalRules.length > 0) lines.push(`# Regras globais\n${config.globalRules.join("\n")}`);
  lines.push(`# Escopo\n${scopeInstruction(config)}`);
  const humanWords = humanRequestTerms(config);
  if (humanWords.length > 0) {
    // As palavras da tela não tinham efeito: "pediu uma pessoa" dependia só
    // do modelo adivinhar.
    lines.push(`# Pedido de atendente\nSe o cliente pedir para ser atendido por uma pessoa (ex.: ${humanWords.map((w) => `"${w}"`).join(", ")}), marque handoff=true e diga que vai chamar alguém da equipe. Palavra solta no meio de outro assunto ("a pessoa que me atendeu disse…") não é pedido. Vale só o pedido feito na mensagem atual: pedido de uma mensagem anterior já foi tratado — se a conversa segue com você, responda o que o cliente perguntou agora. Se ele pede uma pessoa e faz uma pergunta na mesma mensagem, responda a pergunta com as fontes; marque handoff=true só se não conseguir responder.`);
  }
  if (humanRequestWithQuestion) {
    lines.push("# Nesta mensagem\nO cliente pediu uma pessoa e também fez uma pergunta ou disse o assunto. Responda a pergunta com as fontes (dados dele, trechos, informações fixas). Marque handoff=true só se não conseguir responder com o que tem.");
  }
  lines.push(`# Fontes\n${SOURCES_GUIDE}`);
  lines.push(`# Como escrever\n${WRITING_GUIDE}`);
  // Fecho configurado: quem põe é o motor; o modelo não cria o próprio.
  if (hasReplyEnding(effectiveReplyEnding(config, activeTheme(config, themeId)))) lines.push(REPLY_ENDING_PROMPT);
  if ((config.fallback?.confusion?.action ?? "rephrase") === "rephrase") lines.push(CONFUSION_PROMPT);
  lines.push(`# Procedimentos e listas\n${PROCEDURE_GUIDE}`);
  lines.push(`# Tamanho das respostas\n${responseLengthInstruction(config.responseLength)}`);
  lines.push(`# Emojis\n${emojiInstruction(config.emojis)}`);
  const bold = boldInstruction(config.bold);
  if (bold) lines.push(`# Negrito\n${bold}`);
  lines.push(`# Data de hoje\n${currentDateLine(config.businessHours?.timezone)}`);
  const hours = businessHoursText(config);
  if (hours) lines.push(`# Horário de atendimento da equipe\n${hours}\nUse quando o cliente perguntar o horário. Fora dele, diga que a equipe responde no próximo horário.`);
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
    lines.push(`# Assunto ativo: ${activeTheme(config, themeId)?.name ?? themeId}`);
    lines.push(themeInstructions);
  }

  if (collectedVariables && Object.keys(collectedVariables).length > 0) {
    lines.push("# Variáveis já coletadas nesta conversa");
    lines.push(JSON.stringify(collectedVariables));
  }

  // Resumo do atendimento anterior (ou o corrente): contexto para entender
  // uma resposta curta a uma pergunta antiga, sem repetir nada ao cliente.
  if (priorSummary?.text) {
    const when = priorSummary.at ? ` — ${priorSummary.at.toLocaleDateString("pt-BR", { timeZone: timezone })}` : "";
    const who = priorSummary.agent ? ` · ${priorSummary.agent}` : "";
    lines.push(priorSummary.current ? "# Resumo desta conversa até aqui" : `# Último atendimento deste cliente (resumo)${when}${who}`);
    lines.push(priorSummary.text);
    lines.push("Use este resumo só para entender o contexto. Não o repita ao cliente nem diga que leu um resumo. Se a mensagem atual responde a algo que ficou pendente ali, continue de onde parou.");
  }

  // Transferência transparente entre agentes: o cliente não percebe a troca.
  if (transparentTransfer) {
    lines.push("# Continuidade");
    lines.push("Esta conversa veio de outro assistente da mesma equipe e o cliente não sabe disso. Continue o atendimento como se fosse o mesmo assistente: não se apresente, não cumprimente de novo, não diga que recebeu a conversa nem que ela foi transferida. Responda direto ao que o cliente pediu.");
  }

  const calendar = calendarPromptSection(config.calendar?.events, new Date(), timezone);
  if (calendar) lines.push(calendar);

  if (prefetchedChunks.length > 0) {
    lines.push("# Trechos da base de conhecimento relacionados à mensagem");
    lines.push("Já buscados pelo significado da mensagem. Use os que atendem ao pedido; ignore os outros sem mencioná-los.");
    prefetchedChunks.forEach((c, i) => {
      const max = c.priority ? PRIORITY_CHUNK_CHARS : PREFETCH_CHUNK_CHARS;
      const raw = c.content.length > max ? `${c.content.slice(0, max)}…` : c.content;
      const body = markPastDates(raw, new Date(), timezone);
      lines.push(`[${i + 1}] ${c.docTitle}${c.priority ? " (material do assunto)" : ""}\n${body}`);
    });
  }
  if (nothingRelevant) {
    // Sem trecho que responda, o modelo completava com conhecimento geral.
    lines.push("# Sem material para esta mensagem");
    lines.push("A busca nos materiais não achou trecho que responda a esta mensagem (os que aparecem acima, se houver, só se parecem com ela). Se ela pede informação sobre produto, serviço, preço, prazo, regra, política ou como fazer algo, não responda com conhecimento geral nem com o que parece óbvio: diga com naturalidade que não tem essa informação e marque handoff=true se o cliente precisa dela para seguir. Cumprimento, agradecimento, confirmação e perguntas sobre os dados do próprio cliente você responde normalmente.");
  }
  if (messageModels.length > 0) {
    lines.push("# Mensagens prontas que você pode enviar");
    lines.push(`Para enviar uma, devolva messageModel: { "id": "<id>" }. ${messageModelPromptRule(messageModelModeFor(config, themeId))}`);
    if (config.messageModelAdapt) {
      lines.push("Se o texto da mensagem pronta precisar se encaixar na conversa (tratamento, responder primeiro o ponto que o cliente perguntou), devolva também \"adapt\": true. O conteúdo não muda: links, números, datas e passos ficam iguais.");
    }
    for (const m of messageModels) {
      lines.push(`- ${m.id}: ${m.name}${m.mediaKinds.length > 0 ? ` (inclui ${[...new Set(m.mediaKinds)].join(", ")})` : ""}`);
      if (m.content?.trim()) lines.push(`  Texto: ${m.content.trim().replace(/\s*\n\s*/g, " / ")}`);
    }
  }
  if (flows.length > 0) {
    lines.push("# Formulários (Flows) que você pode enviar");
    lines.push("São flows publicados no WhatsApp. Envie só quando o cliente precisar preencher esse formulário. Devolva flow: { \"id\": \"<id>\" }. A reply é uma frase curta avisando que o formulário vem em seguida; não peça no texto os dados que o formulário já coleta.");
    for (const f of flows) lines.push(`- ${f.id}: ${f.name}`);
  }
  if (attachmentsSection) lines.push(attachmentsSection);

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
    ...(flows.length > 0 ? { flow: null } : {}),
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
    ...(flows.length > 0 ? ["- flow: null ou { id: string } com o id de um formulário da lista. Nunca um objeto vazio."] : []),
    ...(attachmentsSection ? ["- attachments: ids de \"Anexos dos materiais\" para enviar, ou []."] : []),
    "- collected: dados que o cliente informou neste turno; vazio se nenhum.",
    "- concluded: true só quando o cliente indicou que terminou (agradeceu, se despediu ou disse que era só isso) e não fez pedido novo nesta mensagem. Se ele perguntou algo, responda e deixe concluded=false.",
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
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[ai-v2] Erro ao carregar as etapas das ações",
    );
    return [];
  }
}

async function describeAllowedFlows(ids: string[]): Promise<Array<{ id: string; name: string }>> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (wanted.length === 0) return [];
  const { listPublishedFlowDefinitions } = await import("@/services/whatsapp-flow-definitions");
  const rows = await listPublishedFlowDefinitions();
  const allow = new Set(wanted);
  return rows.filter((r) => allow.has(r.id)).map((r) => ({ id: r.id, name: r.name }));
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
  /** O cliente pediu uma pessoa e fez uma pergunta na mesma mensagem. */
  humanRequestWithQuestion?: boolean;
  /** Resumo do atendimento anterior do contato (ou corrente desta conversa). */
  priorSummary?: { text: string; at?: Date | null; agent?: string | null; current?: boolean } | null;
  /** Conversa recebida de outro agente de IA em modo transparente: sem se apresentar. */
  transparentTransfer?: boolean;
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
  noteV2Fact("model", args.config.model);
  const promptTheme = activeTheme(args.config, args.themeId);
  const promptDocIds = knowledgeDocIdsFor(args.config, promptTheme);
  const modelIds = allowedMessageModelIdsFor(args.config, promptTheme);
  const flowIds = allowedFlowIdsFor(args.config);
  // Chave do fornecedor da resposta (Claude → Anthropic; a busca nos
  // materiais continua com a chave OpenAI), títulos dos materiais, mensagens
  // prontas e etapas: leituras independentes, em paralelo — em série cada
  // uma somava sua ida ao banco à espera do cliente.
  const [chatKey, docTitleMap, messageModels, actionStages, flows] = await Promise.all([
    getAgentChatKey(args.agentId, args.config.model, apiKey),
    // Títulos dos materiais permitidos: ajudam o modelo a decidir quando
    // chamar knowledge_search e a contextualizar a resposta.
    promptDocIds.length > 0
      ? knowledgeDocTitleMapByIds(args.agentId, promptDocIds).catch((err) => {
          log.warn(
            { err: err instanceof Error ? err.message : err },
            "[ai-v2] Erro ao carregar títulos dos materiais",
          );
          return new Map<string, string>();
        })
      : Promise.resolve(new Map<string, string>()),
    // Mensagens prontas liberadas (assunto, senão globais) com o tipo de mídia.
    describeV2MessageModels(modelIds).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[ai-v2] Erro ao carregar mensagens prontas",
      );
      return [] as V2MessageModelSummary[];
    }),
    actionStageNames(args.config, promptTheme),
    describeAllowedFlows(flowIds).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[ai-v2] Erro ao carregar flows",
      );
      return [] as Array<{ id: string; name: string }>;
    }),
  ]);
  const knowledgeDocTitles = promptDocIds.map((id) => docTitleMap.get(id)).filter((t): t is string => Boolean(t));
  // Texto das mensagens prontas só no modo "combinar" e só das 3 mais ligadas à
  // mensagem do cliente (todas iriam inchar o prompt); nos outros modos o
  // modelo escolhe pelo nome.
  const combineModels = messageModelModeFor(args.config, promptTheme?.id) === "combine"
    ? new Set(
        [...messageModels]
          .map((m) => ({ id: m.id, score: sharedContentWords(args.userMessage, `${m.name} ${m.content ?? ""}`) }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((m) => m.id),
      )
    : new Set<string>();
  for (const m of messageModels) if (!combineModels.has(m.id)) delete m.content;
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

  const prefetch = await prefetchKnowledge({
    agentId: args.agentId,
    apiKey,
    config: args.config,
    themeId: args.themeId,
    materialTitles: knowledgeDocTitles,
    docTitles: docTitleMap,
    userMessage,
    previousMessages,
  });
  // Entra no trace como uma consulta à base: o aterramento da resposta e o
  // log do turno enxergam os trechos. Só quando achou algo — pré-busca
  // vazia não pode contar como "consultou e não achou".
  // Anexos dos materiais lidos (vídeo, imagem, áudio, PDF): o modelo pode
  // pedir para enviar depois da reply.
  const offeredAttachments = await attachmentsForDocs(args.agentId, prefetch.chunks.map((c) => c.docId));
  // Semelhança do melhor trecho de cada material (para o envio automático e o rastro).
  const docSimilarity = new Map<string, number>();
  for (const c of prefetch.chunks) if (c.docId) docSimilarity.set(c.docId, Math.max(docSimilarity.get(c.docId) ?? 0, 1 - c.distance));
  const docTitleOf = new Map(prefetch.chunks.map((c) => [c.docId, c.docTitle]));
  if (offeredAttachments.length > 0) {
    traceStep("base", `Anexos disponíveis dos materiais lidos: ${offeredAttachments
      .map((x) => `"${x.name}" (material "${docTitleOf.get(x.docId) ?? "?"}" ${(docSimilarity.get(x.docId) ?? 0).toFixed(2)}; ${x.autoSend ? "enviar sempre" : "o agente decide"}${x.description ? "" : "; sem “quando enviar”"})`)
      .join(", ")}`);
  }
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
    prefetch.searched && (prefetch.chunks.length === 0 || (prefetch.best ?? 0) < WEAK_MATCH_SIMILARITY),
    attachmentsPromptSection(offeredAttachments),
    args.humanRequestWithQuestion === true,
    flows,
    args.priorSummary ?? null,
    args.transparentTransfer === true,
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
          apiKey: chatKey,
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
      log.warn("[ai-v2] LLM resposta cortada por length; expandindo maxOutputTokens");
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
        apiKey: chatKey,
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
        log.warn(
          { textLength: text.length },
          "[ai-v2] LLM não devolveu JSON válido; normalizador também falhou.",
        );
      } else {
        log.warn(
          { err: validated.error.message, textLength: text.length },
          "[ai-v2] LLM devolveu JSON fora do schema",
        );
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
        log.warn({ rawId }, "[ai-v2] LLM devolveu messageModel.id inválido; ignorado.");
      }
    }

    // messageModel é uma forma curta de devolver a ação send_message_model.
    if (output.messageModel?.id) {
      output.actions = [
        {
          type: "send_message_model",
          modelId: output.messageModel.id,
          variables: output.messageModel.variables,
          ...(output.messageModel.adapt && args.config.messageModelAdapt ? { adapt: true } : {}),
        },
        ...output.actions,
      ];
    }
    // Id copiado com erro de digitação vira o da lista mostrada ao modelo.
    const shownModelIds = messageModels.map((m) => m.id);
    output.actions = output.actions.map((a) => {
      if (a.type !== "send_message_model" || typeof a.modelId !== "string") return a;
      const fixed = repairMessageModelId(a.modelId, shownModelIds);
      if (fixed === a.modelId) return a;
      traceStep("mensagem pronta", `Id "${a.modelId}" corrigido para "${fixed}" (erro de cópia do modelo)`);
      return { ...a, modelId: fixed };
    });

    if (output.flow?.id) {
      const shownFlowIds = flows.map((f) => f.id);
      const flowId = repairMessageModelId(output.flow.id, shownFlowIds);
      if (flowId !== output.flow.id) {
        traceStep("flow", `Id "${output.flow.id}" corrigido para "${flowId}" (erro de cópia do modelo)`);
        output.flow = { id: flowId };
      }
      const already = output.actions.some((a) => a.type === "send_whatsapp_flow" && a.flowId === flowId);
      if (!already) output.actions = [{ type: "send_whatsapp_flow", flowId }, ...output.actions];
    }

    // Anexos pedidos: só os oferecidos neste turno; viram a ação de envio.
    const offeredIds = new Set(offeredAttachments.map((a) => a.id));
    const chosen = [...new Set((output.attachments ?? []).filter((id) => offeredIds.has(id)))];
    // "Enviar sempre": sai quando o material dele é fonte forte da resposta
    // (qualquer um dos trechos lidos, não só o primeiro) e a resposta não é
    // só um aviso de transferência (com orientação antes, o anexo vai junto).
    const onlyTransfer = output.handoff && !answersBeforeHandoff(output.reply);
    const strongDoc = (docId: string) => (docSimilarity.get(docId) ?? 0) >= MAIN_SOURCE_SIMILARITY;
    const automatic = onlyTransfer
      ? []
      : offeredAttachments.filter((a) => a.autoSend && strongDoc(a.docId) && !chosen.includes(a.id)).map((a) => a.id);
    if (automatic.length > 0) traceStep("mídia", `Anexo de envio automático (material é fonte forte da resposta): ${automatic.map((id) => offeredAttachments.find((x) => x.id === id)?.name ?? id).join(", ")}`);
    // Por que um anexo "enviar sempre" não saiu: a tela mostra o motivo.
    for (const a of offeredAttachments.filter((x) => x.autoSend && !chosen.includes(x.id) && !automatic.includes(x.id))) {
      const sim = docSimilarity.get(a.docId) ?? 0;
      traceStep("mídia", `"${a.name}" não enviado: ${onlyTransfer ? "o turno só transferiu" : `o material "${docTitleOf.get(a.docId) ?? "?"}" não é fonte forte da resposta (${sim.toFixed(2)} < ${MAIN_SOURCE_SIMILARITY.toFixed(2)})`}`);
    }
    const picked = [...chosen, ...automatic].slice(0, MATERIAL_ATTACHMENT_LIMITS.perReply);
    output.attachments = picked;
    if (chosen.length > 0) traceStep("mídia", `O agente pediu para enviar: ${chosen.map((id) => offeredAttachments.find((x) => x.id === id)?.name ?? id).join(", ")}`);
    if (picked.length > 0) {
      output.actions = [...output.actions, { type: "send_material_attachment", attachmentIds: picked } as V2Action];
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
    // Link citado que não está nos trechos lidos: procura nos materiais
    // liberados (o trecho com o link nem sempre vem na busca por
    // significado). Domínio liberado na configuração também é fonte: o
    // operador autorizou esse endereço.
    const replyUrls = [...r.output.reply.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
    const readTexts = [...prefetch.chunks.map((c) => c.content), ...knowledgeChunkTexts(r.toolCalls)].join("\n");
    const missingUrls = replyUrls.filter((u) => !readTexts.includes(u));
    const linkedChunks = missingUrls.length > 0
      ? await knowledgeChunksContaining({ agentId: args.agentId, needles: missingUrls, allowedDocIds: promptDocIds }).catch(() => [])
      : [];
    if (linkedChunks.length > 0) traceStep("verificação", `Link citado encontrado em material liberado: ${[...new Set(linkedChunks.map((c) => `"${c.docTitle}"`))].join(", ")}`);
    const allowedDomainsLine = (args.config.allowedDomains ?? []).length > 0
      ? `Endereços liberados pela empresa (podem ser citados): ${args.config.allowedDomains.map((d) => `https://${d}`).join(", ")}`
      : "";
    // O valor que o cliente digitou vai ao modelo como marcador; nas fontes
    // (cadastro, consultas) ele aparece por extenso e a resposta que repetia
    // o marcador era barrada como "sem fonte". As fontes ganham o mesmo
    // marcador — o valor real não vai ao modelo que confere.
    const known = (s: string) => (vault.size > 0 ? vault.tokenizeKnown(s) : s);
    const contextJson = known(JSON.stringify([args.context.contact, args.context.selectedDeal, args.context.citableContact, args.context.citableDeal]));
    const lookupTexts = lookupResultTexts(r.toolCalls).map(known);
    // Só o que é fonte de verdade. Com o prompt inteiro (guias, lista de
    // títulos de todos os materiais) qualquer palavra comum, como
    // "Documentos" ou "Solicitações", passava como se tivesse fonte.
    const sources = [
      userMessage,
      ...previousMessages.map((m) => m.content),
      ...prefetch.chunks.flatMap((c) => [c.docTitle, c.content]),
      ...knowledgeChunkTexts(r.toolCalls),
      ...linkedChunks.flatMap((c) => [c.docTitle, c.content]),
      allowedDomainsLine,
      ...lookupTexts,
      args.themeInstructions ?? "",
      ...args.config.globalRules,
      ...args.config.variables.map((v) => `${v.key}: ${v.value}`),
      ...(args.config.calendar?.events ?? []).map((e) => e.title),
      ...messageModels.map((m) => m.name),
      // Modo "combinar": o texto da mensagem pronta mostrado ao modelo é fonte.
      ...messageModels.map((m) => m.content ?? "").filter((t) => t.trim()),
      contextJson,
      calendarPromptSection(args.config.calendar?.events, new Date(), args.config.businessHours?.timezone || "America/Sao_Paulo"),
      businessHoursText(args.config),
      // "Hoje é domingo", "o encontro de 19/09 já passou": vêm da data de hoje.
      currentDateLine(args.config.businessHours?.timezone),
    ];
    // Fontes de fato: sem as mensagens da conversa (o que o cliente diz não
    // prova que a coisa existe).
    const factSources = sources.slice(1 + previousMessages.length);
    const clientTexts = [userMessage, ...previousMessages.filter((m) => m.role === "user").map((m) => m.content)];
    // Valores que o cliente informou sobre a própria situação ("a cobrança
    // veio R$ 480") contam como fonte nas regras: explicar a cobrança dele com
    // a regra do material é o esperado. Confirmar como preço da empresa um
    // valor que só o cliente disse ("é R$ 30, né?" → "isso") fica com a
    // checagem por modelo, que distingue os dois casos.
    type Unsupported = { label: string; text: string };
    const tz = args.config.businessHours?.timezone || "America/Sao_Paulo";
    const unsupportedOf = (reply: string, reason?: string): Unsupported[] => [
      // Tempo verbal que a data desmente e que não se conserta só no verbo
      // ("já passou" com data que ainda vem): a frase sai.
      ...tenseMismatches(reply, new Date(), tz).filter((t) => !t.fixed).map((t) => ({ label: `"${t.sentence}" (${t.why})`, text: t.sentence })),
      // Instrução que a própria decisão desautoriza ("a possibilidade de X
      // não está especificada" + "acesse o portal e confira a opção de X"):
      // sai só essa frase; o reconhecimento e o resto da resposta ficam.
      ...admittedMissingInstructions(reply, reason).map((s) => ({ label: `"${s}" (instrução sobre o que a própria decisão admite não estar no material)`, text: s })),
      ...clientNamesBoundToFacts(reply, clientTexts, factSources).map((n) => ({ label: `"${n}" (nome citado pelo cliente que não está nas fontes, ligado a data ou valor)`, text: n })),
      ...unsupportedQuotedTerms(reply, sources, factSources).map((t) => ({ label: `"${t}"`, text: t })),
      ...unsupportedMenuPaths(reply, sources, factSources).map((t) => ({ label: `"${t}"`, text: t })),
      ...unsupportedFigures(reply, sources, clientTexts).map((t) => ({ label: t, text: t })),
      ...unsupportedFacts(reply, sources, clientTexts).map((t) => ({ label: t, text: t })),
      ...unsupportedHedges(reply, sources).map((h) => ({ label: `"${h}" (palpite sem fonte)`, text: h })),
    ];
    // Checagem por modelo: o que as regras não pegam (política sem número,
    // conhecimento geral, recurso ou material que não existe). Só roda
    // quando as regras não acharam nada e a resposta não é transferência.
    // O que o agente já disse não é fonte: uma afirmação sem fonte que
    // escapasse num turno sustentaria as seguintes. Vai só como contexto.
    // Fontes fixas (calendário, horário, data, informações fixas, instruções,
    // cadastro) antes dos trechos longos: com o limite de tamanho da
    // checagem, o calendário ficava no fim e era cortado — a data certa do
    // calendário era barrada como "sem fonte" e o cliente, transferido.
    const fixedFirst = [
      calendarPromptSection(args.config.calendar?.events, new Date(), args.config.businessHours?.timezone || "America/Sao_Paulo"),
      businessHoursText(args.config),
      currentDateLine(args.config.businessHours?.timezone),
      ...args.config.variables.map((v) => `${v.key}: ${v.value}`),
      args.themeInstructions ?? "",
      ...args.config.globalRules,
      contextJson,
      allowedDomainsLine,
      ...linkedChunks.map((c) => `${c.docTitle}\n${c.content}`),
      ...messageModels.filter((m) => m.content?.trim()).map((m) => `${m.name}\n${m.content}`),
      ...lookupTexts,
    ].filter((s) => s && s.trim());
    const claimSources = [...fixedFirst, ...factSources.filter((s) => !fixedFirst.includes(s))];
    const agentHistory = previousMessages.filter((m) => m.role === "assistant").map((m) => m.content);
    // O que o agente pode dizer do cadastro (inclui informações montadas):
    // valor literal nos dados é sustentado sem depender do modelo.
    const citableValues = [args.context.citableContact, args.context.citableDeal]
      .flatMap((o) => Object.values(o ?? {}))
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter((v) => v.length >= 4);
    const modelClaims = async (output: V2LLMOutput): Promise<Unsupported[]> => {
      // Transferência só com o aviso não tem o que conferir; com orientação
      // (que agora chega ao cliente antes do aviso), confere.
      if ((output.handoff && !answersBeforeHandoff(output.reply)) || !worthClaimCheck(output.reply)) return [];
      if ((args.config.groundingCheck ?? "model") !== "model") {
        traceStep("verificação", "Checagem por modelo desligada na configuração — só as regras fixas conferiram a resposta");
        return [];
      }
      // Apresentação curta de mensagem pronta/anexo: o conteúdo vem do
      // material; a frase só anuncia o envio ("vou te orientar…"). Conferir
      // a frase barrava o envio e transferia o cliente.
      const presentsMaterial = !!output.messageModel?.id || (output.attachments?.length ?? 0) > 0;
      if (presentsMaterial && output.reply.trim().split(/\s+/).length <= 40) return [];
      const checkArgs = { model: v2FastAuxModel(args.config.model), apiKey, reply: output.reply, sources: claimSources, clientTexts, agentHistory, citableValues };
      let res = await checkClaimsWithModel(checkArgs);
      r.inputTokens += res.inputTokens;
      r.outputTokens += res.outputTokens;
      // Checagem que falhou (erro ou tempo) tenta mais uma vez: sem ela, o
      // passo a passo não conferido virava transferência.
      if (!res.ok) {
        res = await checkClaimsWithModel(checkArgs);
        r.inputTokens += res.inputTokens;
        r.outputTokens += res.outputTokens;
      }
      // Segunda leitura quando a primeira marca algo: o checador varia de uma
      // chamada para outra e barrava, uma vez em cinco, o passo que o material
      // traz com outras palavras — a mesma pergunta ora respondia, ora
      // transferia. Fica marcado só o que as duas leituras apontam.
      if (res.ok && res.unsupported.length > 0) {
        const again = await checkClaimsWithModel(checkArgs);
        r.inputTokens += again.inputTokens;
        r.outputTokens += again.outputTokens;
        if (again.ok) {
          const confirmed = res.unsupported.filter((c) => again.unsupported.some((d) => sameClaim(c, d)));
          if (confirmed.length < res.unsupported.length) {
            traceStep("verificação", `Segunda leitura não confirmou ${res.unsupported.length - confirmed.length} marcação(ões) — ${res.unsupported.filter((c) => !confirmed.includes(c)).map((c) => `"${c}"`).join(", ")}`);
          }
          res.unsupported = confirmed;
        }
      }
      // Checagem indisponível (erro ou tempo): passo a passo, caminho de tela
      // ou link não conferido não sai — as regras fixas não pegam esses.
      if (!res.ok && statesProcedure(output.reply)) {
        traceStep("verificação", "Checagem por modelo indisponível e a resposta traz passo a passo, caminho ou link não conferido");
        return [{ label: "um passo a passo, caminho ou link que não pôde ser conferido nos materiais", text: "" }];
      }
      if (!res.ok) traceStep("verificação", "Checagem por modelo indisponível (erro ou tempo) — só as regras fixas conferiram a resposta");
      if (res.unsupported.length > 0) traceStep("verificação", `Checagem por modelo: ${res.unsupported.length} afirmação(ões) sem fonte — ${res.unsupported.map((c) => `"${c}"`).join(", ")}`);
      else if (res.ok) traceStep("verificação", "Checagem por modelo: tudo sustentado pelos materiais");
      return res.unsupported.map((c) => ({ label: `"${c}" (afirmação que não está nos materiais)`, text: c }));
    };
    const labelsOf = (list: Unsupported[]) => list.map((u) => u.label);
    const textsOf = (list: Unsupported[]) => list.map((u) => u.text).filter(Boolean);

    // Tempo verbal x data: "os encontros foram realizados de 06/11 a 09/11"
    // com 06/11 ainda por vir. Quando é só o verbo, conserta; senão a frase
    // sai (regra em `unsupportedOf`).
    for (const t of tenseMismatches(r.output.reply, new Date(), tz)) {
      if (!t.fixed) continue;
      r.output = { ...r.output, reply: r.output.reply.replace(t.sentence, t.fixed) };
      traceStep("verificação", `Tempo verbal corrigido: ${t.why}`);
    }
    let output = r.output;
    let flags = unsupportedOf(output.reply, output.reason);
    // A checagem por modelo já leu as frases que sobram? Depois dela, o
    // corte não precisa de nova checagem (só das regras fixas).
    let modelChecked = false;
    if (flags.length === 0) {
      flags = await modelClaims(output);
      modelChecked = true;
    }
    if (flags.length === 0) return;
    const firstLabels = labelsOf(flags);
    const firstList = firstLabels.join(", ");
    noteV2Fact("verification", { unsupported: firstLabels, rewritten: false, forcedHandoff: false });

    // 1) Corte: tira só as frases marcadas, sem nova chamada ao modelo. A
    // reescrita pelo modelo parafraseava a mesma afirmação e o cliente era
    // transferido sem receber a parte certa da resposta. Duas rodadas no
    // máximo: a segunda cobre o que a checagem por modelo apontar no que sobrou.
    const removedTexts: string[] = [];
    for (let round = 0; round < 2 && flags.length > 0 && textsOf(flags).length === flags.length; round += 1) {
      const trimmed = trimUnsupportedSentences(output.reply, textsOf(flags));
      if (!trimmed) break;
      const candidate: V2LLMOutput = { ...output, reply: trimmed.reply };
      let still = unsupportedOf(candidate.reply, candidate.reason);
      if (still.length === 0 && !modelChecked) {
        still = await modelClaims(candidate);
        modelChecked = true;
      }
      traceStep("verificação", `Resposta cita ${labelsOf(flags).join(", ")}, que não está no material nem na conversa — frase retirada da resposta`);
      removedTexts.push(...trimmed.removed);
      output = candidate;
      flags = still;
    }
    if (flags.length === 0) {
      noteV2Fact("verification", { unsupported: firstLabels, rewritten: true, trimmed: removedTexts, forcedHandoff: false });
      r.output = output;
      return;
    }

    // 2) Reescrita pelo modelo: só tirar o que foi apontado, sem trocar por
    // outra afirmação parecida. Se ela devolve só frases que já estavam na
    // resposta, não há nada novo a conferir por modelo.
    const list = labelsOf(flags).join(", ");
    traceStep("verificação", `Resposta cita ${list}, que não está no material nem na conversa — pedindo reescrita`);
    const reviewSystem = [
      system,
      "# REVISÃO",
      `Sua resposta anterior cita ${list}, que não aparece nos trechos da base, nas instruções nem na conversa. Tire essas afirmações da resposta e mantenha o resto como está: não as substitua por outra afirmação parecida, por uma generalidade ("pode variar", "depende do caso") nem por algo que também não esteja nas fontes. Use só nomes, passos e caminhos que estão nos trechos. Nome que o cliente citou e que não está nas fontes: não confirme que existe nem atribua a ele data, valor ou regra própria — dê a regra geral e diga que não consegue confirmar esse item. Não monte um passo a passo geral a partir do procedimento de outro serviço nem do que aparece numa imagem. Se, sem essas afirmações, não sobra resposta ao que o cliente pediu, diga com naturalidade que não tem essa informação e marque handoff=true. Devolva o JSON completo no formato exigido.`,
    ].join("\n\n");
    try {
      const res = await generateWithTools({
        model: args.config.model,
        apiKey: chatKey,
        system: reviewSystem,
        messages: [...messages, { role: "assistant", content: JSON.stringify(output) }] as any,
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
        // Reescrita que perdeu o link ou começa no meio ("Se aparecer…") não
        // sai assim: melhor uma pessoa do que uma resposta mutilada.
        if (!fixed.handoff && isMutilated(output.reply, fixed.reply, textsOf(flags))) {
          traceStep("verificação", "A reescrita ficou mutilada (perdeu o link ou a abertura) — não sai assim");
          throw new Error("reescrita mutilada");
        }
        let still = unsupportedOf(fixed.reply, fixed.reason);
        const rulesClean = still.length === 0;
        if (rulesClean && modelChecked && onlyKeptSentences(fixed.reply, output.reply, textsOf(flags))) {
          traceStep("verificação", "A reescrita só tirou as frases apontadas — sem nova checagem");
        } else if (rulesClean) {
          still = await modelClaims(fixed);
        }
        // A reescrita trouxe outra afirmação sem fonte: corta essa também,
        // se o que sobra ainda responde (senão, transfere).
        if (still.length > 0 && rulesClean && textsOf(still).length === still.length) {
          const trimmed = trimUnsupportedSentences(fixed.reply, textsOf(still));
          if (trimmed && unsupportedOf(trimmed.reply, fixed.reason).length === 0) {
            traceStep("verificação", `A reescrita ainda citava ${labelsOf(still).join(", ")} — frase retirada da resposta`);
            fixed.reply = trimmed.reply;
            still = [];
          }
        }
        if (still.length === 0) {
          traceStep("verificação", "Reescrita só com o material");
          noteV2Fact("verification", { unsupported: labelsOf(flags), rewritten: true, forcedHandoff: false });
          r.output = fixed;
          return;
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[ai-v2] revisão de termos falhou",
      );
    }
    traceStep("verificação", "A reescrita ainda cita o que não está no material — transferindo");
    noteV2Fact("verification", { unsupported: labelsOf(flags), rewritten: false, forcedHandoff: true });
    noteV2Fact("handoffCause", "verification", { keepFirst: true });
    r.output = {
      ...output,
      reply: args.config.fallback?.noSource?.message || args.config.handoff?.message || "Vou chamar uma pessoa da equipe para te ajudar com isso.",
      handoff: true,
      actions: [...output.actions.filter((a) => a.type !== "handoff"), { type: "handoff" }],
      reason: `Citava ${firstList === list ? list : `${firstList}; depois ${list}`}, que não está no material.`,
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
        apiKey: chatKey,
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
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[ai-v2] reescrita de repetição falhou",
      );
    }
    r.output = { ...r.output, reply: repeatFallback(last, args.config) };
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
