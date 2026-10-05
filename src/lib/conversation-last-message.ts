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
 *
 * `contacts.lastMessageAt` / `contacts.lastMessageDirection` (Kanban: ordem
 * por última interação, cursor e filtro de direção) são gravadas AQUI, logo
 * depois da conversa — `touchContactLastMessage`. Os dois escritores de
 * `conversations.lastMessageAt` (este arquivo e `touchInbound`) passam por
 * ela; não existe outro ponto.
 */
import { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const log = getLogger("conversation-last-message");

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
  /**
   * Direção da mensagem (vai para `contacts.lastMessageDirection`). Padrão
   * `"out"`: quem chama sem informar são envios nossos (automação, IA,
   * template, eco do celular); mensagem do cliente entra por `touchInbound`.
   */
  direction?: ChatDirection;
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
  await touchContactLastMessage({
    conversationId: args.conversationId,
    at: args.at,
    direction: args.direction ?? "out",
    tx: args.tx,
  });
}

export type ChatDirection = "in" | "out";

/**
 * Última mensagem de chat do CONTATO (`contacts.lastMessageAt` e
 * `lastMessageDirection`), a partir da conversa que acabou de receber a
 * mensagem. Guarda monotônica no WHERE: mensagem atrasada (webhook fora de
 * ordem, backfill) não escreve nada — nem horário nem direção regridem. Em
 * empate de horário vale a última gravação.
 *
 * Instrução separada da conversa, de propósito: numa só (CTE) ela travaria
 * conversa → contato, a ordem inversa de quem atualiza o contato e depois as
 * conversas dele (herança de responsável), e as duas poderiam se bloquear.
 * Fora de transação cada instrução solta a trava ao terminar.
 *
 * SQL cru: não mexe em `contacts.updatedAt`. Falha aqui não derruba o envio
 * (só registra) — exceto dentro de uma transação de quem chamou, onde o erro
 * tem que subir (a transação já estaria abortada).
 */
export async function touchContactLastMessage(args: {
  conversationId: string;
  at: Date;
  direction: ChatDirection;
  tx?: RawWriter;
}): Promise<void> {
  const run = (db: RawWriter) => db.$executeRaw`
    UPDATE contacts ct
    SET "lastMessageAt" = ${args.at},
        "lastMessageDirection" = ${args.direction}
    FROM conversations cv
    WHERE cv.id = ${args.conversationId}
      AND ct.id = cv."contactId"
      AND (ct."lastMessageAt" IS NULL OR ct."lastMessageAt" <= ${args.at})
  `;
  if (args.tx) {
    await run(args.tx);
    return;
  }
  try {
    await run(prisma);
  } catch (err) {
    log.warn(
      { err, conversationId: args.conversationId },
      "Falha ao gravar a última mensagem do contato (não-fatal)",
    );
  }
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
    // `isListChatMessage` já garantiu "in" | "out".
    direction: args.message.direction === "in" ? "in" : "out",
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
