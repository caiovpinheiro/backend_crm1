/**
 * Flag `conversation.hasError` (fila Inbox → Erro).
 *
 * Regra de produto: se o cliente já respondeu depois (última mensagem real
 * do chat é `direction = "in"`), a falha de envio deixa de ser acionável —
 * a conversa volta para Entrada/Aguardando/Respondidas. Status `failed`
 * tardio da Meta ou o sweeper de outbound NÃO podem recolocar a conversa
 * em Erro nesse caso (race clássico: envio falha → cliente responde →
 * webhook failed chega).
 *
 * Importante: NÃO usar o denormalizado `conversation.lastMessageDirection`.
 * Com `countAgentReplyAsAnswered` OFF (default), outbound de bot/automação/IA
 * não atualiza essa coluna — ela fica `"in"` mesmo com a última bolha sendo
 * um envio falho (ex.: saudação fora da janela 24h). Isso prendia o ticket
 * em Entrada em vez da aba Erro.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

type Db = Pick<PrismaClient, "conversation" | "message">;

/** Alinhado ao preview da lista (`lastMessagePreviewsBatch`). */
const CHAT_PREVIEW_EXCLUDED = [
  "note",
  "ai_draft",
  "ai_summary",
  "whatsapp_call",
  "whatsapp_call_recording",
] as const;

/**
 * Marca a conversa com erro de envio, a menos que o último evento do chat
 * seja inbound do cliente. Retorna `true` se marcou.
 */
export async function markConversationHasError(
  conversationId: string,
  db: Db = prisma,
): Promise<boolean> {
  const last = await db.message
    .findFirst({
      where: {
        conversationId,
        isPrivate: false,
        messageType: { notIn: [...CHAT_PREVIEW_EXCLUDED] },
        direction: { in: ["in", "out"] },
      },
      orderBy: { createdAt: "desc" },
      select: { direction: true },
    })
    .catch(() => null);

  if (last?.direction === "in") {
    return false;
  }

  await db.conversation
    .update({
      where: { id: conversationId },
      data: { hasError: true, updatedAt: new Date() },
    })
    .catch(() => {});
  return true;
}
