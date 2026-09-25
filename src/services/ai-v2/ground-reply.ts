/**
 * A resposta ao cliente acompanha o trecho recuperado da base.
 * Nenhum assunto ou documento de cliente aqui.
 */

import type { V2AgentConfig, V2Theme } from "@/lib/ai-v2/types";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { getV2ThemeById, knowledgeDocIdsFor } from "./themes";
import { searchV2Knowledge } from "./tools";

const GREETINGS = new Set([
  "oi", "ola", "bom", "dia", "boa", "tarde", "noite",
  "ok", "sim", "nao", "obrigado", "obrigada", "valeu",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ");
}

export function hasSearchableQuestion(message: string): boolean {
  return normalize(message)
    .split(/\s+/)
    .some((word) => word.length >= 4 && !GREETINGS.has(word));
}

export function knowledgeChunkTexts(
  toolCalls: Array<{ toolName: string; result: unknown }> | undefined,
): string[] {
  const texts: string[] = [];
  for (const call of toolCalls ?? []) {
    if (call.toolName !== "knowledge_search") continue;
    const result = call.result as { chunks?: unknown } | undefined;
    if (!result || !Array.isArray(result.chunks)) continue;
    for (const chunk of result.chunks) {
      if (!chunk || typeof chunk !== "object") continue;
      const content = (chunk as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) texts.push(content.trim());
    }
  }
  return texts;
}

function allowedDocIds(config: V2AgentConfig, themeId?: string): string[] {
  return knowledgeDocIdsFor(config, getV2ThemeById(config, themeId));
}

export function knowledgeQueries(message: string, theme: V2Theme | null): string[] {
  const queries = [message.trim()].filter(Boolean);
  if (!theme) return queries;
  const messageWords = new Set(normalize(message).split(/\s+/).filter((word) => word.length >= 4));
  const matched = (theme.when ?? [])
    .map((phrase) => phrase.trim())
    .filter((phrase) => {
      const words = normalize(phrase).split(/\s+/).filter((word) => word.length >= 4);
      return words.some((word) => messageWords.has(word));
    });
  if (matched.length > 0) queries.push(matched.join(" "));
  return queries;
}

/**
 * Nomes citados entre aspas na resposta (menu, botão, tela, opção) que não
 * aparecem em nenhuma fonte (material, instruções, conversa). É onde o
 * modelo mais inventa ao completar um passo a passo: "vá em \"Fale Conosco\"".
 */
export function unsupportedQuotedTerms(reply: string, sources: string[]): string[] {
  const haystack = ` ${normalize(sources.join(" ")).replace(/\s+/g, " ")} `;
  const out = new Set<string>();
  for (const m of reply.matchAll(/["“”]([^"“”\n]{2,60})["“”]/g)) {
    const term = m[1].trim();
    const norm = normalize(term).replace(/\s+/g, " ").trim();
    if (!norm || !/[a-z]/.test(norm)) continue;
    if (!haystack.includes(` ${norm} `)) out.add(term);
  }
  return [...out];
}

/**
 * Percentual e valor em dinheiro na resposta que não aparecem em nenhuma
 * fonte. O modelo completava com "juros de 1% ao mês", "R$ 50 de taxa".
 */
export function unsupportedFigures(reply: string, sources: string[]): string[] {
  const squash = (s: string) => s.replace(/\s+/g, "").replace(/\.(?=\d{3}\b)/g, "").toLowerCase();
  const haystack = squash(sources.join(" "));
  const out = new Set<string>();
  const patterns = [/\d+(?:[.,]\d+)?\s?%/g, /R\$\s?\d[\d.]*(?:,\d{1,2})?/gi];
  for (const re of patterns) {
    for (const m of reply.matchAll(re)) {
      const token = m[0].trim();
      if (!haystack.includes(squash(token))) out.add(token);
    }
  }
  return [...out];
}

function tokensOf(s: string): string[] {
  return normalize(s).split(/\s+/).filter((w) => w.length > 1);
}

/** Resposta quase igual à anterior (o envio a barraria e o cliente ficaria sem nada). */
export function isNearDuplicateReply(a: string, b: string): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join(" ") === tb.join(" ")) return true;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.85;
}

/** O texto livre só fica se repetir palavras do material. Senão, vale o trecho. */
export function groundedReply(reply: string, chunks: string[]): string {
  const unique = [...new Set(chunks.map((chunk) => chunk.trim()).filter(Boolean))].slice(0, 3);
  if (unique.length === 0) return reply;
  const replyNorm = normalize(reply);
  const tokens = new Set<string>();
  for (const chunk of unique) {
    for (const word of normalize(chunk).split(/\s+/)) {
      if (word.length >= 5) tokens.add(word);
    }
  }
  if (tokens.size === 0) return unique.join("\n\n");
  let hits = 0;
  for (const word of tokens) {
    if (replyNorm.includes(word)) hits += 1;
  }
  const enough = hits >= 3 && hits * 2 >= Math.min(tokens.size, 12);
  return enough ? reply : unique.join("\n\n");
}

export async function answerFromKnowledge(args: {
  reply: string;
  toolCalls: Array<{ toolName: string; args?: unknown; result: unknown }> | undefined;
  config: V2AgentConfig;
  themeId?: string;
  userMessage: string;
  agentId: string;
}): Promise<string> {
  // O modelo já recebeu os trechos no prompt (pré-busca): a resposta dele
  // é a leitura do material. Trocar por trecho cru aqui transformaria uma
  // pergunta de esclarecimento, ou uma resposta que corretamente ignorou um
  // trecho não pertinente, em despejo de material.
  if (args.toolCalls?.some((c) => c.toolName === "knowledge_search" && (c as { args?: { prefetch?: boolean } }).args?.prefetch)) {
    return args.reply;
  }
  const fromTools = knowledgeChunkTexts(args.toolCalls);
  if (fromTools.length > 0) return groundedReply(args.reply, fromTools);

  const docIds = allowedDocIds(args.config, args.themeId);
  if (docIds.length === 0 || !hasSearchableQuestion(args.userMessage)) return args.reply;

  try {
    const apiKey = await getAgentApiKey(args.agentId);
    const theme = getV2ThemeById(args.config, args.themeId);
    for (const query of knowledgeQueries(args.userMessage, theme)) {
      const found = await searchV2Knowledge({
        agentId: args.agentId,
        apiKey,
        query,
        allowedDocIds: docIds,
        limit: 3,
      });
      const texts = found.chunks.map((chunk) => chunk.content).filter((content) => content.trim());
      if (texts.length > 0) return groundedReply(args.reply, texts);
    }
  } catch {
    return args.reply;
  }
  return args.reply;
}
