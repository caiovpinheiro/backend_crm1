import { encryptSecret } from "@/lib/secret-crypto";
import {
  apiKeyHint,
  looksLikeAnthropicApiKey,
  looksLikeOpenAiApiKey,
  sanitizeAnthropicApiKey,
  sanitizeOpenAiApiKey,
} from "@/services/ai/agent-key";

/** Igual à da OpenAI, para a chave Anthropic (`sk-ant-…`). */
export function anthropicKeyFields(
  raw: string | null | undefined,
): { anthropicApiKeyEnc: string | null; anthropicApiKeyHint: string | null } | null {
  if (raw === undefined) return null;
  const key = sanitizeAnthropicApiKey(raw ?? "");
  if (!key) return { anthropicApiKeyEnc: null, anthropicApiKeyHint: null };
  if (!looksLikeAnthropicApiKey(key)) {
    throw new Error("Formato de chave Anthropic inválido. Esperado algo como sk-ant-…");
  }
  return { anthropicApiKeyEnc: encryptSecret(key), anthropicApiKeyHint: key.slice(-4) };
}

/**
 * Traduz `openaiApiKey` (texto puro vindo do front) nos campos de banco.
 * - `undefined` → não mexe.
 * - `null` / `""` → limpa.
 * - `"sk-…"` → cifra + hint.
 */
export function openaiKeyFields(
  raw: string | null | undefined,
): { openaiApiKeyEnc: string | null; openaiApiKeyHint: string | null } | null {
  if (raw === undefined) return null;
  const key = sanitizeOpenAiApiKey(raw ?? "");
  if (!key) return { openaiApiKeyEnc: null, openaiApiKeyHint: null };
  if (!looksLikeOpenAiApiKey(key)) {
    throw new Error("Formato de chave OpenAI inválido. Esperado algo como sk-…");
  }
  return { openaiApiKeyEnc: encryptSecret(key), openaiApiKeyHint: apiKeyHint(key) };
}
