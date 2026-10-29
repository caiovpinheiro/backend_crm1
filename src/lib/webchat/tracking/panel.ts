/**
 * Webchat v2 — dados do painel "No site agora" do inbox
 * (docs/decisoes/webchat-widget.md §9.3). Lê só o último estado gravado
 * (uma linha por canal+contato) e os `WEBCHAT_RECENT_EVENTS` eventos mais
 * recentes pelo índice `(contactId, occurredAt desc)` — nunca reprocessa a
 * linha do tempo. Roda no contexto de org do usuário (prisma tenant-scoped).
 */
import { prisma } from "@/lib/prisma";
import { readContextState, type WebchatContextState } from "@/lib/webchat/live-context";
import { readWebchatV2Config, WEBCHAT_RECENT_EVENTS } from "@/lib/webchat/v2-config";

import type { WebchatEventDto } from "./realtime";

/** Canal da conversa webchat (`Conversation.channel`). */
const WEBCHAT_CONVERSATION_CHANNEL = "webchat";

export type WebchatSitePanelDto = {
  /** `false` = conversa fora do webchat ou sem contato: o painel não aparece. */
  available: boolean;
  contactId: string | null;
  channelId: string | null;
  /** chave → rótulo da config do canal (sem rótulo, o painel mostra a chave). */
  labels: Record<string, string>;
  context: { state: WebchatContextState; updatedAt: string } | null;
  /** Mais recentes primeiro. */
  events: WebchatEventDto[];
};

const UNAVAILABLE: WebchatSitePanelDto = {
  available: false,
  contactId: null,
  channelId: null,
  labels: {},
  context: null,
  events: [],
};

function readEventData(raw: unknown): WebchatContextState | null {
  const state = readContextState(raw);
  return Object.keys(state).length > 0 ? state : null;
}

/** Painel da conversa (já autorizada pelo chamador). */
export async function loadWebchatSitePanel(conversation: {
  channel: string | null;
  channelId: string | null;
  contactId: string | null;
}): Promise<WebchatSitePanelDto> {
  const { channelId, contactId } = conversation;
  if (conversation.channel !== WEBCHAT_CONVERSATION_CHANNEL || !channelId || !contactId) {
    return UNAVAILABLE;
  }
  const [channel, row, events] = await Promise.all([
    prisma.channel.findFirst({
      where: { id: channelId },
      select: { provider: true, config: true },
    }),
    prisma.webchatLiveContext.findFirst({
      where: { channelId, contactId },
      select: { state: true, updatedAt: true },
    }),
    prisma.webchatEvent.findMany({
      where: { contactId, channelId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: WEBCHAT_RECENT_EVENTS,
      select: { id: true, name: true, data: true, important: true, occurredAt: true },
    }),
  ]);
  if (!channel || channel.provider !== "WEBCHAT") return UNAVAILABLE;
  return {
    available: true,
    contactId,
    channelId,
    labels: readWebchatV2Config(channel.config).context.labels,
    context: row
      ? { state: readContextState(row.state), updatedAt: row.updatedAt.toISOString() }
      : null,
    events: events.map((e) => ({
      id: e.id,
      name: e.name,
      data: readEventData(e.data),
      important: e.important,
      occurredAt: e.occurredAt.toISOString(),
    })),
  };
}
