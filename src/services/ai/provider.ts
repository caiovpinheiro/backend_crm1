/**
 * Fachada sobre o Vercel AI SDK.
 *
 * Isola a escolha do provider/modelo do resto do sistema: o runner
 * só chama `getModel(name)` e usa as funções `generateWithTools`
 * e `embedTexts` daqui. Se no futuro quisermos trocar para Anthropic,
 * Groq, Gemini etc., só este arquivo muda.
 */

import { createOpenAI } from "@ai-sdk/openai";
import {
  embedMany,
  generateText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

/**
 * Chave OpenAI: **sempre por agente** (`AIAgentConfig.openaiApiKeyEnc`).
 * CRM multi-tenant — não há chave global, nem fallback pra `.env`. Quem
 * chama (runner / retrieval / indexação) resolve a chave do agente e
 * passa aqui. Sem chave → erro claro, o agente não roda.
 */
const NO_KEY_MSG =
  "Este agente não tem chave OpenAI configurada. Cadastre a chave na tela do agente.";

// Clientes cacheados por chave (poucas chaves distintas por processo).
const clientByKey = new Map<string, ReturnType<typeof createOpenAI>>();

function getOpenAI(apiKey: string | null | undefined) {
  const key = apiKey?.trim();
  if (!key) throw new Error(NO_KEY_MSG);
  const cached = clientByKey.get(key);
  if (cached) return cached;
  const client = createOpenAI({ apiKey: key });
  clientByKey.set(key, client);
  return client;
}

/** Invalida os clientes cacheados — chamar quando uma chave muda na UI. */
export function resetAIProviderCache(): void {
  clientByKey.clear();
}

export function getModel(
  modelName: string,
  apiKey: string | null | undefined,
): LanguageModel {
  return getOpenAI(apiKey)(modelName);
}

export const DEFAULT_CHAT_MODEL =
  process.env.AI_DEFAULT_MODEL ?? "gpt-4o-mini";
export const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export type GenerateArgs = {
  model: string;
  /// Chave OpenAI do agente. Obrigatória — não há chave global.
  apiKey: string;
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  temperature?: number;
  maxOutputTokens?: number;
  /// Limite de passos (tool loop). Default 8.
  maxSteps?: number;
};

export type GenerateResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{
    toolName: string;
    args: unknown;
    result: unknown;
  }>;
  steps: number;
};

export async function generateWithTools(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const model = getModel(args.model, args.apiKey);
  const result = await generateText({
    model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    temperature: args.temperature ?? 0.7,
    maxOutputTokens: args.maxOutputTokens,
    stopWhen: stepCountIs(args.maxSteps ?? 8),
  });

  const toolCalls: GenerateResult["toolCalls"] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls ?? []) {
      const matchedResult = (step.toolResults ?? []).find(
        (r) =>
          (r as { toolCallId?: string }).toolCallId ===
          (call as { toolCallId?: string }).toolCallId,
      );
      toolCalls.push({
        toolName: (call as { toolName: string }).toolName,
        args: (call as { input?: unknown; args?: unknown }).input ??
          (call as { args?: unknown }).args,
        result: matchedResult
          ? (matchedResult as { output?: unknown; result?: unknown }).output ??
            (matchedResult as { result?: unknown }).result
          : undefined,
      });
    }
  }

  return {
    text: result.text ?? "",
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    toolCalls,
    steps: result.steps.length,
  };
}

export async function embedTexts(
  texts: string[],
  apiKey: string,
): Promise<{
  embeddings: number[][];
  inputTokens: number;
}> {
  const openai = getOpenAI(apiKey);
  const result = await embedMany({
    model: openai.textEmbeddingModel(DEFAULT_EMBEDDING_MODEL),
    values: texts,
  });
  return {
    embeddings: result.embeddings,
    inputTokens: result.usage?.tokens ?? 0,
  };
}
