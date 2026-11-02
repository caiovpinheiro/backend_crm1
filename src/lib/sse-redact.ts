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
  // Escopo do board (só ids): sem eles quem não lista a conversa voltaria
  // a refazer o board inteiro a cada mensagem da org.
  "pipelineIds",
  "dealIds",
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

/** Nota interna e rascunhos da IA: o texto não sai pelo fan-out da organização. */
const PRIVATE_MESSAGE_TYPES = new Set(["note", "ai_draft", "ai_summary"]);

/**
 * `new_message` privado sem conteúdo, para todas as conexões. Esses eventos não
 * levam `card` (não mudam a prévia), então o gate por usuário não os alcança: sem
 * isto, o texto chegaria a toda a organização. `cardOmitted: "hidden"` faz o cliente
 * não pintar bolha e refazer o GET do chat aberto, que aplica o acesso.
 */
export function redactPrivateNewMessage<T extends { messageType?: string | null }>(
  payload: T,
): T {
  if (!payload.messageType || !PRIVATE_MESSAGE_TYPES.has(payload.messageType)) return payload;
  return redactNewMessageForUnlisted({ ...payload, cardOmitted: "hidden" }) as T;
}
