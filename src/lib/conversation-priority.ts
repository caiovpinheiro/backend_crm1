/**
 * Conversa prioritária (docs/decisoes/webchat-widget.md §9.12).
 *
 * `priorityAt` só vale com a conversa aberta e sem resposta humana. A prioridade
 * termina sozinha na primeira resposta humana ou ao encerrar: todo caminho já
 * grava `hasHumanReply` e `status`, e estas colunas são o predicado do índice
 * parcial `conversations_active_priority_idx`. Não há gancho para limpar.
 */
import type { Prisma } from "@prisma/client";

/** Quantas prioritárias sobem para o topo da 1ª página do inbox. */
export const INBOX_PRIORITY_PREFIX_LIMIT = 50;

export const ACTIVE_PRIORITY_WHERE = {
  priorityAt: { not: null },
  status: "OPEN",
  hasHumanReply: false,
} satisfies Prisma.ConversationWhereInput;

/** O `priorityAt` da linha, só enquanto a prioridade vale. */
export function activePriorityAt(row: {
  priorityAt?: Date | null;
  status?: string | null;
  hasHumanReply?: boolean | null;
}): Date | null {
  if (!row.priorityAt || row.status !== "OPEN" || row.hasHumanReply) return null;
  return row.priorityAt;
}
