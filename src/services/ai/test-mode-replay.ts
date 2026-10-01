/**
 * `#refazer`: reprocessa a última pergunta do cliente com as correções que
 * acabaram de ser gravadas.
 *
 * Sem isto o ciclo de correção tem um buraco no meio. O operador vê o
 * desvio, escreve `#regra`, e aí precisa inventar uma pergunta parecida para
 * saber se resolveu — comparando duas respostas a duas perguntas diferentes,
 * que é exatamente o jeito de não descobrir nada. Refazer a MESMA pergunta
 * isola a variável.
 *
 * Reentra pelo `maybeReplyAsAIAgent`, o mesmo caminho do inbound de verdade,
 * em vez de montar um turno paralelo. É o que garante que o replay exercita
 * regra de assunto, base de conhecimento, gates e prompt na mesma ordem da
 * produção — um simulador que roda outro código responde por si mesmo, não
 * pelo agente.
 *
 * Não cria `ConversationTurn` nem `Message`: a pergunta original continua
 * sendo a única do cliente no histórico. O que o replay produz é uma
 * resposta nova, e o modo de teste garante que ela não tem efeito.
 */

import { isContentlessInbound } from "@/lib/ai-agents/media-placeholder";
import { prisma } from "@/lib/prisma";

/** Quantas mensagens olhar para trás procurando a última pergunta real. */
const LOOKBACK = 20;

/**
 * Última mensagem do cliente que dá para reprocessar.
 *
 * Pula comando (`#…`) e mídia sem legenda: reprocessar "[Imagem]" devolveria
 * o tratamento de mídia, não a resposta que o operador quer reavaliar.
 */
export async function findLastCustomerQuestion(
  conversationId: string,
): Promise<string | null> {
  const messages = await prisma.message.findMany({
    where: { conversationId, direction: "inbound" },
    orderBy: { createdAt: "desc" },
    take: LOOKBACK,
    select: { content: true },
  });

  for (const message of messages) {
    const text = (message.content ?? "").trim();
    if (!text) continue;
    if (text.startsWith("#")) continue;
    if (isContentlessInbound(text)) continue;
    return text;
  }
  return null;
}

export async function replayLastQuestion(args: {
  conversationId: string;
  contactId: string;
  channel: "meta" | "baileys";
  question: string;
}): Promise<void> {
  const { maybeReplyAsAIAgent } = await import("@/services/ai/inbox-handler");
  await maybeReplyAsAIAgent({
    conversationId: args.conversationId,
    contactId: args.contactId,
    userMessage: args.question,
    channel: args.channel,
  });
}
