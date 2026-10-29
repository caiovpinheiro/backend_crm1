/**
 * "Agente digitando…" para o widget (polling — o SSE do visitante é fase 4).
 * A rota de typing do agente marca uma chave curta; o `GET /messages` do
 * visitante lê. TTL = janela em que o indicador fica aceso sem nova batida
 * (o composer bate a cada 3 s).
 */
import { cache } from "@/lib/cache";

export const WEBCHAT_AGENT_TYPING_TTL_SEC = 6;

function key(orgId: string, conversationId: string): string {
  return `webchat:agent_typing:${orgId}:${conversationId}`;
}

export async function markWebchatAgentTyping(orgId: string, conversationId: string): Promise<void> {
  await cache.set(key(orgId, conversationId), 1, WEBCHAT_AGENT_TYPING_TTL_SEC).catch(() => {});
}

export async function isWebchatAgentTyping(orgId: string, conversationId: string): Promise<boolean> {
  try {
    return (await cache.get<number>(key(orgId, conversationId))) === 1;
  } catch {
    return false;
  }
}
