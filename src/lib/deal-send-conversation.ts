/**
 * Qual conversa usar quando uma integração (node do n8n) envia pelo negócio
 * (`POST /api/deals/:id/messages`).
 *
 * Antes a rota sempre chamava `ensureWhatsAppConversationForContact` sem
 * canal, que só olha o canal Meta padrão da org. Em org com mais de um número
 * (DNAWORK: "DNA Work - Empresas" padrão, candidatos no "DNA Work
 * Candidaturas"), cada nota ou mensagem sem `channelId` abria um ticket novo,
 * vazio e sem responsável, no canal errado — 1.159 em 30 dias, 641 ainda
 * abertos sem dono (DNAWORK #81090/#81144/#81264).
 *
 * Regra: canal pedido → garante a conversa nesse canal. Sem canal → reusa a
 * conversa aberta mais recente do contato (qualquer canal). Sem conversa
 * aberta → canal padrão, como antes.
 */
export type DealSendConversationCandidate = { id: string; channelId: string | null };

export type DealSendConversationChoice =
  | { action: "reuse"; conversationId: string }
  | { action: "ensure"; channelId: string | null };

export function pickDealSendConversation(input: {
  channelId?: string | null;
  /** Conversas WhatsApp não resolvidas do contato, mais recente primeiro. */
  active: DealSendConversationCandidate[];
}): DealSendConversationChoice {
  const channelId = (input.channelId ?? "").trim();
  if (channelId) return { action: "ensure", channelId };
  const current = input.active.find((c) => (c.channelId ?? "").trim());
  if (current) return { action: "reuse", conversationId: current.id };
  return { action: "ensure", channelId: null };
}
