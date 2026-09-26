/**
 * Resolve a chave OpenAI de um agente (`AIAgentConfig.openaiApiKeyEnc`).
 *
 * CRM multi-tenant: cada agente tem sua própria chave. Não há chave
 * global nem fallback pra `.env`. Sem chave (ou chave que não
 * descriptografa) → erro claro; o agente não roda.
 */

import { prismaBase } from "@/lib/prisma-base";
import { decryptSecret, hasCryptoSecret } from "@/lib/secret-crypto";

const NO_KEY_MSG =
  "Este agente não tem chave OpenAI configurada. Cadastre a chave na tela do agente.";

/**
 * Cópia de PDF, WhatsApp, `.env` ou gerenciador de senha traz lixo
 * (aspas, `Bearer`, quebra de linha, hífen tipográfico). A chave real
 * não tem espaço — removemos isso antes de validar, senão o PUT inteiro
 * do agente falhava e nenhuma outra alteração gravava.
 */
export function sanitizeOpenAiApiKey(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^(?:Bearer\s+|OPENAI_API_KEY\s*=\s*)/i, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s\r\n]+/g, "");
}

/**
 * Aceita `sk-…`, `sk-proj-…` e `sk-svcacct-…`. Pontos, `+`, `/` e `=`
 * entram porque chaves novas da OpenAI às vezes vêm em base64.
 */
export function looksLikeOpenAiApiKey(raw: string): boolean {
  const key = sanitizeOpenAiApiKey(raw);
  return /^sk-[A-Za-z0-9._~+/-]{10,}$/.test(key);
}

/** Últimos 4 chars da chave — só pra exibição na UI. */
export function apiKeyHint(rawKey: string): string {
  const k = sanitizeOpenAiApiKey(rawKey) || rawKey.trim();
  return k.length >= 4 ? k.slice(-4) : "";
}

/**
 * Chave em claro do agente. Lança se não configurada ou se o blob não
 * descriptografa (segredo de cripto diferente de quando foi salva).
 */
export async function getAgentApiKey(agentId: string): Promise<string> {
  const row = await prismaBase.aIAgentConfig.findUnique({
    where: { id: agentId },
    select: { openaiApiKeyEnc: true },
  });
  if (!row?.openaiApiKeyEnc) throw new Error(NO_KEY_MSG);
  let key: string;
  try {
    key = decryptSecret(row.openaiApiKeyEnc).trim();
  } catch {
    throw new Error(
      hasCryptoSecret()
        ? "A chave OpenAI deste agente não pôde ser lida (gravada com outro segredo de criptografia). Re-cadastre a chave na tela do agente."
        : "Este processo não tem segredo de criptografia (ENCRYPTION_KEY/NEXTAUTH_SECRET ausente) e não consegue ler a chave OpenAI. Corrija o ambiente do serviço — não adianta re-cadastrar a chave.",
    );
  }
  if (!key) throw new Error(NO_KEY_MSG);
  return key;
}

/** Chave Anthropic colada com lixo (aspas, "Bearer", espaços): limpa. */
export function sanitizeAnthropicApiKey(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^(?:Bearer\s+|ANTHROPIC_API_KEY\s*=\s*)/i, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s\r\n]+/g, "");
}

export function looksLikeAnthropicApiKey(raw: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{10,}$/.test(sanitizeAnthropicApiKey(raw));
}

/** Chave Anthropic do agente (modelos Claude). Lança se não houver. */
export async function getAgentAnthropicKey(agentId: string): Promise<string> {
  const row = (await prismaBase.aIAgentConfig.findUnique({
    where: { id: agentId },
    select: { anthropicApiKeyEnc: true } as never,
  })) as { anthropicApiKeyEnc?: string | null } | null;
  if (!row?.anthropicApiKeyEnc) throw new Error("NO_ANTHROPIC_KEY");
  let key: string;
  try {
    key = decryptSecret(row.anthropicApiKeyEnc).trim();
  } catch {
    throw new Error("A chave Anthropic deste agente não pôde ser lida. Cadastre a chave de novo na tela do agente.");
  }
  if (!key) throw new Error("NO_ANTHROPIC_KEY");
  return key;
}

export async function tryGetAgentAnthropicKey(agentId: string): Promise<string | null> {
  try {
    return await getAgentAnthropicKey(agentId);
  } catch {
    return null;
  }
}

/**
 * Chave para responder ao cliente com `model`: Claude usa a da Anthropic; os
 * demais, a da OpenAI (`openaiKey`, quando já carregada).
 */
export async function getAgentChatKey(agentId: string, model: string, openaiKey?: string): Promise<string> {
  if (model.startsWith("claude-")) return getAgentAnthropicKey(agentId);
  return openaiKey ?? getAgentApiKey(agentId);
}

/** Variante que não lança — pra checagens de "está configurado?". */
export async function tryGetAgentApiKey(
  agentId: string,
): Promise<string | null> {
  try {
    return await getAgentApiKey(agentId);
  } catch {
    return null;
  }
}
