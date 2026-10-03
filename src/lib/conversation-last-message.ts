/**
 * `conversations.lastMessageAt` — horário da última mensagem de CHAT da
 * conversa (entrada ou saída), a chave de ordem da lista do inbox.
 *
 * O recorte é o MESMO da prévia do card (`lastMessagePreviewsBatch` em
 * `services/conversations.ts`) e do backfill
 * (`scripts/backfill-conversations-last-message-at.mjs`): conta mensagem
 * pública com direção `in`/`out`; nota interna, rascunho da IA, ligação e
 * evento de sistema não contam. Mudou aqui → mude nos dois.
 *
 * Quem grava: o ponto que cria a mensagem, no MESMO `conversation.update`
 * que já toca a conversa logo depois (marcação de resposta, `hasError`…),
 * espalhando `lastMessageAtData(...)`. Só onde não existe update nenhum é
 * que se usa `touchConversationLastMessageAt` (uma escrita a mais).
 * Inbound passa por `touchInbound` (`lib/conversation-inbound.ts`), que já
 * grava as duas colunas na mesma instrução.
 *
 * Ler, atribuir, encerrar ou reabrir NÃO mexe na coluna — é isso que impede a
 * lista de reordenar quando alguém só abre a conversa.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/** `messageType` que nunca é mensagem de chat (além de `event*`). */
export const NON_CHAT_MESSAGE_TYPES = [
  "note",
  "ai_draft",
  "whatsapp_call",
  "whatsapp_call_recording",
] as const;

const NON_CHAT_SET: ReadonlySet<string> = new Set(NON_CHAT_MESSAGE_TYPES);

export type ChatMessageShape = {
  direction?: string | null;
  /** Ausente = `text` (default da coluna). */
  messageType?: string | null;
  isPrivate?: boolean | null;
};

/** A mensagem entra na prévia do card e na ordem da lista? */
export function isListChatMessage(m: ChatMessageShape): boolean {
  if (m.isPrivate) return false;
  if (m.direction !== "in" && m.direction !== "out") return false;
  const type = m.messageType || "text";
  if (NON_CHAT_SET.has(type)) return false;
  if (type.startsWith("event")) return false;
  return true;
}

/**
 * Campo a espalhar no `conversation.update` que já existe logo depois da
 * criação da mensagem. Vazio quando a mensagem não é de chat.
 *
 *   await prisma.conversation.update({
 *     where: { id },
 *     data: { ...HUMAN_OUTBOUND_REPLY_MARK, ...lastMessageAtData(saved) },
 *   });
 */
export function lastMessageAtData(
  m: ChatMessageShape & { createdAt?: Date | null },
  at?: Date,
): { lastMessageAt: Date } | Record<string, never> {
  if (!isListChatMessage(m)) return {};
  return { lastMessageAt: at ?? m.createdAt ?? new Date() };
}

type RawWriter = { $executeRaw: typeof prisma.$executeRaw };

/**
 * Para os pontos que criam mensagem de chat SEM atualizar a conversa
 * depois. Nunca anda para trás (mensagem atrasada não rebaixa a conversa).
 */
export async function touchConversationLastMessageAt(args: {
  conversationId: string;
  at: Date;
  tx?: RawWriter;
}): Promise<void> {
  const db = args.tx ?? prisma;
  await db.$executeRaw`
    UPDATE conversations
    SET "lastMessageAt" = ${args.at}
    WHERE id = ${args.conversationId}
      AND ("lastMessageAt" IS NULL OR "lastMessageAt" < ${args.at})
  `;
}

/**
 * Predicado SQL do recorte, para consultas cruas sobre `messages` (alias
 * opcional). Usado pela prévia do card.
 */
export function chatMessageSqlFilter(alias?: string): Prisma.Sql {
  const col = (name: string) =>
    alias ? Prisma.raw(`${alias}."${name}"`) : Prisma.raw(`"${name}"`);
  return Prisma.sql`${col("isPrivate")} = false
    AND ${col("messageType")} NOT IN (${Prisma.join([...NON_CHAT_MESSAGE_TYPES])})
    AND ${col("messageType")} NOT LIKE 'event%'
    AND ${col("direction")} IN ('in', 'out')`;
}
