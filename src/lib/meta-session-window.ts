import type { Prisma } from "@prisma/client";

import { WHATSAPP_SESSION_WINDOW_MS } from "@/services/whatsapp-session-expiry";

/** Canais WhatsApp Cloud (Meta) — mesma lista do filtro de sessão a expirar. */
export const META_WHATSAPP_CHANNELS = [
  "whatsapp",
  "whatsapp_meta",
  "meta_whatsapp",
] as const;

export function metaWhatsappConversationWhere(): Prisma.ConversationWhereInput {
  return {
    channel: { in: [...META_WHATSAPP_CHANNELS] },
    channelRef: { is: { provider: "META_CLOUD_API" } },
  };
}

/**
 * Janela 24h da Meta (texto livre). Aberta = último inbound do ticket
 * ainda dentro de 24h; fechada = sem inbound ou inbound vencido.
 * Não confundir com `Conversation.status` RESOLVED.
 */
export function metaSessionWindowWhere(
  state: "open" | "closed",
  now = new Date(),
): Prisma.ConversationWhereInput {
  const cutoff = new Date(now.getTime() - WHATSAPP_SESSION_WINDOW_MS);
  const meta = metaWhatsappConversationWhere();
  if (state === "open") {
    return { AND: [meta, { lastInboundAt: { gt: cutoff } }] };
  }
  return {
    AND: [
      meta,
      { OR: [{ lastInboundAt: null }, { lastInboundAt: { lte: cutoff } }] },
    ],
  };
}
