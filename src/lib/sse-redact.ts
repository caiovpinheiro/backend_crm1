/**
 * Campos de `new_message` que podem ir para quem NÃO pode listar a
 * conversa (ou quando não dá para saber — card "budget"): só ids e
 * metadados, o bastante para o cliente casar o thread aberto e refazer o
 * GET (que aplica o controle de acesso). Texto, mídia, legenda, nome do
 * contato/remetente etc. ficam de fora — antes iam para a org inteira.
 * Lista de permitidos, não de proibidos: os publicadores mandam dezenas
 * de campos diferentes.
 */
const UNLISTED_NEW_MESSAGE_KEYS = [
  "organizationId",
  "conversationId",
  "contactId",
  "direction",
  "messageType",
  "timestamp",
  "createdAt",
  "id",
  "messageId",
  "assignedToId",
  "channelId",
  "cardOmitted",
] as const;

export function redactNewMessageForUnlisted(
  rec: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of UNLISTED_NEW_MESSAGE_KEYS) {
    if (key in rec) out[key] = rec[key];
  }
  return out;
}
