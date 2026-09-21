import { encryptSecret } from "@/lib/secret-crypto";
import {
  apiKeyHint,
  looksLikeOpenAiApiKey,
  sanitizeOpenAiApiKey,
} from "@/services/ai/agent-key";

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
