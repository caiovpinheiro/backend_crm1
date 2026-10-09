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
 * Quem grava: `touchConversationLastMessageAt` (GREATEST na própria linha).
 * Não atribuir `lastMessageAt: message.createdAt` num `conversation.update`:
 * uma mensagem atrasada rebaixaria a conversa. Inbound passa por
 * `touchInbound` (`lib/conversation-inbound.ts`), que já usa GREATEST na
 * mesma instrução de `lastInboundAt`.
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
  "ai_summary",
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
 * Horário que esta mensagem proporia para a lista. `null` quando ela não
 * entra no recorte (nota, rascunho, ligação, evento). Não usar o retorno
 * como atribuição de `conversation.update` — gravar só com
 * `touchConversationLastMessageAt` / `touchChatLastMessageAt`.
 */
export function listChatMessageAt(
  m: ChatMessageShape & { createdAt?: Date | null },
  at?: Date,
): Date | null {
  if (!isListChatMessage(m)) return null;
  return at ?? m.createdAt ?? new Date();
}

/**
 * Compatibilidade: não devolve mais `{ lastMessageAt }`. Espalhar isto num
 * update não move a coluna. Quem cria mensagem de chat chama
 * `touchChatLastMessageAt`.
 */
export function lastMessageAtData(
  _m: ChatMessageShape & { createdAt?: Date | null },
  _at?: Date,
): Record<string, never> {
  return {};
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
  // GREATEST ignora NULL no Postgres: coluna vazia recebe `at`; valor maior
  // já gravado permanece. A comparação é na linha, então dois updates
  // concorrentes ficam com o máximo.
  await db.$executeRaw`
    UPDATE conversations
    SET "lastMessageAt" = GREATEST("lastMessageAt", ${args.at})
    WHERE id = ${args.conversationId}
  `;
}

/** Grava `lastMessageAt` só se a mensagem entra no recorte da lista. */
export async function touchChatLastMessageAt(args: {
  conversationId: string;
  message: ChatMessageShape & { createdAt?: Date | null };
  at?: Date;
  tx?: RawWriter;
}): Promise<void> {
  const at = listChatMessageAt(args.message, args.at);
  if (!at) return;
  await touchConversationLastMessageAt({
    conversationId: args.conversationId,
    at,
    tx: args.tx,
  });
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
