/**
 * Fila (carga) de cada responsável = nº de CONVERSAS OPEN atribuídas onde é a
 * VEZ DO AGENTE responder — "Entrada" + "Aguardando" no vocabulário do inbox.
 * Serve de base tanto para o LIMITE (`queueLimit` = teto de conversas abertas
 * simultâneas) quanto para a SELEÇÃO ("menor carga" em `engine.selectResponsible`).
 *
 * Critério (ver AGENT.md 2026-07-30):
 *   `status = OPEN` AND `assignedToId = user` AND `hasError = false`
 *   AND (`hasHumanReply = false` OR `lastMessageDirection = "in"`)
 *
 * Quem já está atribuído ao consultor conta mesmo se o PIPE ainda não
 * encerrou (handoff) — a carga é dele. Robô sem assignee não aparece aqui
 * (não tem assignedToId).
 *
 * `Conversation` é org-scoped, então o filtro de organização é injetado pela
 * Prisma Extension. Uma única `groupBy` (sem N+1).
 */

import { prisma } from "@/lib/prisma";

/**
 * Mapa userId → nº de conversas OPEN aguardando ação do consultor.
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

  const rows = await prisma.conversation.groupBy({
    by: ["assignedToId"],
    where: {
      status: "OPEN",
      assignedToId: { in: userIds },
      hasError: false,
      ...(scopeDeptIds.length > 0
        ? { departmentId: { in: scopeDeptIds } }
        : {}),
      OR: [
        { hasHumanReply: false },
        { lastMessageDirection: "in" },
      ],
    },
    _count: { _all: true },
  });

  for (const row of rows) {
    if (row.assignedToId) result.set(row.assignedToId, row._count._all);
  }
  return result;
}
