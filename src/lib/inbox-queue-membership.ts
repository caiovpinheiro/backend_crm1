/**
 * Predicado único: o que conta como fila ativa (Entrada / Aguardando /
 * Respondidas / Automação / Ligar / Abertas) vs Encerradas.
 *
 * Inbox e Distribuição (`getQueueCounts`, fila de espera) DEVEM usar o
 * mesmo recorte — senão o badge 32+2 da inbox diverge do "34 na fila".
 *
 * A fila segue o **status da conversa**, não o estágio do funil.
 * GANHO/PERDIDO (ou qualquer etapa) NÃO tira o ticket de Entrada/
 * Aguardando. Só encerrar (`RESOLVED` / `closedAt`) faz isso.
 *
 * Defesa além de `status = OPEN`:
 *  - `closedAt` preenchido (status ficou stale após encerrar de verdade)
 *
 * Encerrar também respeita `conversation.keepAgentOnEnd` /
 * `conversation.keepDepartmentOnEnd` (desvincula só quando a org não
 * pediu para manter). Isso é o caminho de close, não este predicado.
 */

import type { Prisma } from "@prisma/client";

/**
 * Guard das filas quentes. Combinar em AND com o predicado da aba
 * (assignee, lastMessageDirection, hasError, …).
 */
export function activeInboxQueueGuardWhere(): Prisma.ConversationWhereInput {
  return {
    status: "OPEN",
    closedAt: null,
  };
}

export function withActiveInboxQueueGuard(
  where: Prisma.ConversationWhereInput,
): Prisma.ConversationWhereInput {
  return { AND: [activeInboxQueueGuardWhere(), where] };
}

/**
 * Aba Encerradas: RESOLVED de verdade, OU status stale com `closedAt`
 * (encerramento real cujo `status` não foi para RESOLVED).
 *
 * Deal GANHO/PERDIDO com conversa ainda OPEN **não** entra aqui.
 */
export function encerradasTabWhere(): Prisma.ConversationWhereInput {
  return {
    OR: [
      { status: "RESOLVED" },
      {
        AND: [
          { status: { not: "RESOLVED" } },
          { closedAt: { not: null } },
        ],
      },
    ],
  };
}
