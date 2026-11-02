/**
 * Webchat — o contato desta conversa está no chat agora?
 * (docs/decisoes/webchat-widget.md §9.13)
 *
 * Ticket "ativo" = ticket webchat do contato que ainda recebe mensagem do
 * visitante (`status` diferente de RESOLVED e sem `closedAt`) em que:
 *  - o visitante está online: alguma sessão do widget do contato, naquele canal,
 *    falou com a API nos últimos `WEBCHAT_VISITOR_ONLINE_MS`; ou
 *  - o visitante escreveu nos últimos `WEBCHAT_RECENT_INBOUND_MS`.
 *
 * Contato sem ticket webchat aberto gasta uma consulta, pelo índice de contato,
 * e não toca nas sessões. Roda só para a conversa aberta, nunca na lista.
 */
import { prisma } from "@/lib/prisma";

/**
 * O widget chama a API a cada 3 s (painel aberto) ou 10 s (fechado), mas
 * `lastSeenAt` só é regravado a cada 60 s (`LAST_SEEN_WRITE_INTERVAL_MS`) e o
 * navegador reduz os timers de aba escondida a um por minuto. Três minutos não
 * apagam quem está na página e soltam logo quem saiu.
 */
export const WEBCHAT_VISITOR_ONLINE_MS = 3 * 60_000;
/** Cobre quem mandou a mensagem e fechou a página: a resposta espera no widget. */
export const WEBCHAT_RECENT_INBOUND_MS = 30 * 60_000;
/** Um ticket ativo por canal webchat (índice parcial único): o teto é folga. */
const MAX_OPEN_WEBCHAT_TICKETS = 10;

export type ActiveWebchatReason = "online" | "recent_message";

export type ActiveWebchatConversation = {
  id: string;
  number: number;
  reason: ActiveWebchatReason;
};

/**
 * Ticket webchat ativo do contato que o usuário pode abrir, ou `null`. Online
 * vem antes de mensagem recente; depois, a mensagem mais nova. `canOpen` evita
 * que o aviso mostre um ticket que daria 404 ao clicar.
 */
export async function findActiveWebchatConversationForContact(args: {
  organizationId: string;
  contactId: string;
  canOpen: (conversationId: string) => Promise<boolean>;
  now?: Date;
}): Promise<ActiveWebchatConversation | null> {
  const now = (args.now ?? new Date()).getTime();
  const tickets = await prisma.conversation.findMany({
    where: {
      organizationId: args.organizationId,
      contactId: args.contactId,
      channel: "webchat",
      status: { not: "RESOLVED" },
      closedAt: null,
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_OPEN_WEBCHAT_TICKETS,
    select: { id: true, number: true, channelId: true, lastInboundAt: true },
  });
  if (tickets.length === 0) return null;

  const channelIds = [...new Set(tickets.flatMap((t) => (t.channelId ? [t.channelId] : [])))];
  const sessions =
    channelIds.length > 0
      ? await prisma.webchatSession.findMany({
          where: {
            organizationId: args.organizationId,
            contactId: args.contactId,
            channelId: { in: channelIds },
            lastSeenAt: { gte: new Date(now - WEBCHAT_VISITOR_ONLINE_MS) },
          },
          select: { channelId: true },
        })
      : [];
  const onlineChannels = new Set(sessions.map((s) => s.channelId));
  const inboundCutoff = now - WEBCHAT_RECENT_INBOUND_MS;

  const candidates = tickets
    .map((t) => {
      const inboundAt = t.lastInboundAt?.getTime() ?? 0;
      const reason: ActiveWebchatReason | null =
        t.channelId && onlineChannels.has(t.channelId)
          ? "online"
          : inboundAt >= inboundCutoff
            ? "recent_message"
            : null;
      return { id: t.id, number: t.number, reason, inboundAt };
    })
    .filter((c): c is typeof c & { reason: ActiveWebchatReason } => c.reason !== null)
    .sort(
      (a, b) =>
        Number(b.reason === "online") - Number(a.reason === "online") || b.inboundAt - a.inboundAt,
    );

  for (const c of candidates) {
    if (await args.canOpen(c.id)) return { id: c.id, number: c.number, reason: c.reason };
  }
  return null;
}
