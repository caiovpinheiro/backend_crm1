/**
 * Fila (carga) de cada responsável = cards da inbox "Entrada" + "Aguardando"
 * daquele consultor. Mesmo critério das abas (`tabToWhere`) e o mesmo
 * colapso da lista (1 card por contato+canal). Alimenta o teto
 * (`queueLimit`) e a seleção ("menor carga" em `engine.selectResponsible`).
 *
 * Um ticket não entra nas duas abas: Entrada = ainda sem reply contável;
 * Aguardando = já teve reply contável e o cliente falou por último.
 * A soma é a dos dois badges/cards, não o colapso da união.
 *
 * `countAgentReplyAsAnswered` entra igual ao inbox: reply de bot/IA pode
 * tirar o card de Entrada e, se a última msg for nossa, de Respondidas
 * (sai da carga). Sem o setting, só `hasHumanReply` move o card.
 *
 * Quem já está atribuído ao consultor conta mesmo se o PIPE ainda não
 * encerrou (handoff). Robô sem assignee humano não aparece aqui.
 */

import {
  countableReplyWhere,
  countAgentReplyAsAnswered,
  inboxCardGroupKey,
  noCountableReplyWhere,
} from "@/lib/conversation-reply-marking";
import { withActiveInboxQueueGuard } from "@/lib/inbox-queue-membership";
import { prisma } from "@/lib/prisma";

function addCard(
  byUser: Map<string, Set<string>>,
  userId: string,
  key: string,
) {
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  set.add(key);
}

/**
 * Mapa userId → nº de cards Entrada + Aguardando do consultor.
 * Usuários sem conversas não aparecem no mapa (o caller assume 0).
 *
 * `departmentIds` (opcional): quando informado, conta APENAS as conversas cujo
 * `Conversation.departmentId` está no conjunto — ou seja, o "volume de fila"
 * fica POR DEPARTAMENTO. Usado na distribuição por departamento para a
 * SELEÇÃO (o consultor concorre pela menor fila DAQUELE departamento). O teto
 * `queueLimit` NÃO usa este número: ele compara a carga total (ver
 * `totalQueueCount` em `responsibles.ts`), senão quem é membro de dois
 * departamentos ganharia um limite por departamento. Vazio/undefined = fila
 * global (todos os departamentos) — usado pela tela/cockpit.
 */
export async function getQueueCounts(
  userIds: string[],
  departmentIds?: string[] | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (userIds.length === 0) return result;

  const scopeDeptIds = (departmentIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const countAgent = await countAgentReplyAsAnswered();
  const deptFilter =
    scopeDeptIds.length > 0 ? { departmentId: { in: scopeDeptIds } } : {};

  const rows = await prisma.conversation.findMany({
    where: withActiveInboxQueueGuard({
      assignedToId: { in: userIds },
      hasError: false,
      ...deptFilter,
      OR: [
        noCountableReplyWhere(countAgent),
        {
          AND: [
            countableReplyWhere(countAgent),
            { lastMessageDirection: "in" },
          ],
        },
      ],
    }),
    select: {
      id: true,
      assignedToId: true,
      contactId: true,
      channel: true,
      hasHumanReply: true,
      hasAgentReply: true,
      lastMessageDirection: true,
    },
  });

  const entrada = new Map<string, Set<string>>();
  const aguardando = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.assignedToId) continue;
    const countable = countAgent
      ? row.hasHumanReply || row.hasAgentReply
      : row.hasHumanReply;
    const key = inboxCardGroupKey(row);
    if (countable && row.lastMessageDirection === "in") {
      addCard(aguardando, row.assignedToId, key);
    } else if (!countable) {
      addCard(entrada, row.assignedToId, key);
    }
  }

  const userIdsWithCards = new Set([...entrada.keys(), ...aguardando.keys()]);
  for (const userId of userIdsWithCards) {
    result.set(
      userId,
      (entrada.get(userId)?.size ?? 0) + (aguardando.get(userId)?.size ?? 0),
    );
  }
  return result;
}
