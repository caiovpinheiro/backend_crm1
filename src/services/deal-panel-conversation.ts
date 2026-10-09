/**
 * Qual ticket do contato o painel do negócio abre.
 *
 * Kanban e Flow leem `contact.conversations[0]` de `GET /api/deals/:id` como
 * "a conversa do negócio". Com ticket ativo, é ele (ver
 * `sortConversationsActiveFirst`). Sem ticket ativo, a ordem do banco
 * (`updatedAt` desc) punha na frente qualquer ticket mexido por último —
 * inclusive tickets abertos e encerrados sem nenhuma mensagem — e o painel
 * mostrava "Nenhuma mensagem nesta conversa." num contato cuja prévia do card
 * (última mensagem em QUALQUER conversa do contato) tinha mensagem.
 *
 * Aqui, só nesse caso (nenhum ticket ativo e mais de um ticket), o ticket com
 * a mensagem de chat mais recente vai para a frente — o mesmo critério da
 * prévia do card em `getBoardData`.
 */
import type { ConversationStatus } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const log = getLogger("deal-panel-conversation");

/** Não são mensagens de chat — mesmo recorte da prévia do card do board. */
const NON_CHAT_MESSAGE_TYPES = ["note", "ai_draft", "ai_summary", "whatsapp_call", "whatsapp_call_recording"];

type PanelConversation = { id: string; status: ConversationStatus };

/**
 * Ativos na frente (ordem do banco entre eles). Entre os encerrados: o da
 * mensagem mais recente primeiro; os sem mensagem por último, na ordem do
 * banco (`sort` é estável).
 */
export function orderConversationsForDealPanel<T extends PanelConversation>(
  conversations: T[],
  lastMessageAt: ReadonlyMap<string, Date>,
): T[] {
  const rank = (c: T) => lastMessageAt.get(c.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return [...conversations].sort((a, b) => {
    const resolvedA = Number(a.status === "RESOLVED");
    const resolvedB = Number(b.status === "RESOLVED");
    if (resolvedA !== resolvedB) return resolvedA - resolvedB;
    if (!resolvedA) return 0;
    const ra = rank(a);
    const rb = rank(b);
    return ra === rb ? 0 : rb > ra ? 1 : -1;
  });
}

/**
 * Sem ticket ativo e com mais de um ticket: uma consulta agrupada (até 20
 * ids, índice `messages(conversationId, createdAt)`) para saber qual tem a
 * última mensagem de chat. Fora desse caso devolve a própria lista, sem
 * consulta. Falha na consulta mantém a ordem recebida.
 */
export async function preferConversationWithLastMessage<T extends PanelConversation>(
  conversations: T[],
): Promise<T[]> {
  if (conversations.length < 2) return conversations;
  if (conversations.some((c) => c.status !== "RESOLVED")) return conversations;
  try {
    const rows = await prisma.message.groupBy({
      by: ["conversationId"],
      where: {
        conversationId: { in: conversations.map((c) => c.id) },
        isPrivate: false,
        direction: { in: ["in", "out"] },
        messageType: { notIn: NON_CHAT_MESSAGE_TYPES },
        NOT: { messageType: { startsWith: "event" } },
      },
      _max: { createdAt: true },
    });
    const lastMessageAt = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.createdAt) lastMessageAt.set(row.conversationId, row._max.createdAt);
    }
    if (lastMessageAt.size === 0) return conversations;
    return orderConversationsForDealPanel(conversations, lastMessageAt);
  } catch (err) {
    log.warn({ err }, "falha ao ordenar tickets pela última mensagem; mantém a ordem do banco");
    return conversations;
  }
}
