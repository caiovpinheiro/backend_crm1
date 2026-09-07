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

/** Últimos 4 chars da chave — só pra exibição na UI. */
export function apiKeyHint(rawKey: string): string {
  const k = rawKey.trim();
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
