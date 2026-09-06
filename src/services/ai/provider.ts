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

import { getSecretSettingOrEnv } from "@/services/settings";

export const AI_OPENAI_KEY_SETTING = "ai.openai.apiKey";

/** Timeout padrão por chamada LLM (Onda 3). */
export const AI_GENERATE_TIMEOUT_MS = 60_000;
/** Tentativas extras em erros transitórios. */
export const AI_GENERATE_MAX_RETRIES = 2;

// Provider OpenAI singleton — construído sob demanda, chave buscada
// primeiro em `system_settings.ai.openai.apiKey` (criptografado) e só
// depois cai para `process.env.OPENAI_API_KEY`. Assim o admin pode
// configurar/rotacionar a chave pela UI sem reiniciar o processo.
let cachedOpenAI: ReturnType<typeof createOpenAI> | null = null;
let cachedKey: string | null = null;

async function getOpenAI() {
  const apiKey = (await getSecretSettingOrEnv(
    AI_OPENAI_KEY_SETTING,
    "OPENAI_API_KEY",
  )).trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY não configurada. Cadastre a chave em Configurações → IA ou defina a variável de ambiente.",
    );
  }
  if (cachedOpenAI && cachedKey === apiKey) return cachedOpenAI;
  cachedOpenAI = createOpenAI({ apiKey });
  cachedKey = apiKey;
  return cachedOpenAI;
}

/**
 * Invalida o cliente em cache — chamar sempre que a chave mudar na UI
 * para que a próxima chamada reinstancie o SDK com a nova credencial.
 */
export function resetAIProviderCache(): void {
  cachedOpenAI = null;
  cachedKey = null;
}

export async function getModel(modelName: string): Promise<LanguageModel> {
  const openai = await getOpenAI();
  return openai(modelName);
}

/**
 * Indica se a plataforma está pronta para falar com a OpenAI.
 * Usado pelos endpoints que precisam avisar o front quando "IA
 * está desativada" (sem chave configurada) antes de o usuário tentar
 * clicar em "Testar" e cair num erro.
 */
export async function isAIConfigured(): Promise<boolean> {
  const apiKey = (await getSecretSettingOrEnv(
    AI_OPENAI_KEY_SETTING,
    "OPENAI_API_KEY",
  )).trim();
  return apiKey.length > 0;
}

export const DEFAULT_CHAT_MODEL =
  process.env.AI_DEFAULT_MODEL ?? "gpt-4o-mini";
export const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export type GenerateArgs = {
  model: string;
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

function isTransientAiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily")
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timeout after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function generateWithTools(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const model = await getModel(args.model);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= AI_GENERATE_MAX_RETRIES; attempt++) {
    try {
      const result = await withTimeout(
        generateText({
          model,
          system: args.system,
          messages: args.messages,
          tools: args.tools,
          temperature: args.temperature ?? 0.7,
          maxOutputTokens: args.maxOutputTokens,
          stopWhen: stepCountIs(args.maxSteps ?? 8),
        }),
        AI_GENERATE_TIMEOUT_MS,
        "generateWithTools",
      );

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
              ? (matchedResult as { output?: unknown; result?: unknown })
                  .output ??
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
    } catch (err) {
      lastErr = err;
      if (attempt >= AI_GENERATE_MAX_RETRIES || !isTransientAiError(err)) {
        throw err;
      }
      const backoffMs = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function embedTexts(texts: string[]): Promise<{
  embeddings: number[][];
  inputTokens: number;
}> {
  const openai = await getOpenAI();
  const result = await embedMany({
    model: openai.textEmbeddingModel(DEFAULT_EMBEDDING_MODEL),
    values: texts,
  });
  return {
    embeddings: result.embeddings,
    inputTokens: result.usage?.tokens ?? 0,
  };
}
