import type { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";

/**
 * Visibilidade de TAREFAS (Activity) por departamento.
 *
 * Regra:
 *   - ADMIN / MANAGER → veem todas as tarefas da org.
 *   - Demais (MEMBER/AGENT) → veem apenas as tarefas atribuídas a si
 *     (`userId = eu`) OU a algum departamento do qual são membros
 *     (`departmentId ∈ meus departamentos`). É a base do "grupo de
 *     suporte" com tarefas compartilhadas.
 *
 * A associação usuário↔departamento vem de `DepartmentMember` (vínculo
 * puramente organizacional). Usamos `prismaBase` com filtro explícito de
 * `organizationId` para não depender do RequestContext estar ativo no
 * momento da chamada (algumas rotas de tarefas não usam withOrgContext).
 */

export type TaskViewer = {
  id: string;
  organizationId: string | null;
  role?: string | null;
  isSuperAdmin?: boolean;
};

export function canSeeAllTasks(viewer: TaskViewer): boolean {
  if (viewer.isSuperAdmin) return true;
  const role = (viewer.role ?? "").toUpperCase();
  return role === "ADMIN" || role === "MANAGER" || role === "OWNER";
}

/** Histórico de notas: só gestão (ADMIN/MANAGER/OWNER). Operador não consulta. */
export function canViewActivityCommentHistory(viewer: TaskViewer): boolean {
  return canSeeAllTasks(viewer);
}

/** Ids dos departamentos dos quais o usuário é membro (na org). */
export async function getUserDepartmentIds(
  userId: string,
  organizationId: string,
): Promise<string[]> {
  try {
    const rows = await prismaBase.departmentMember.findMany({
      where: { userId, organizationId },
      select: { departmentId: true },
    });
    return rows.map((r) => r.departmentId);
  } catch {
    // Tabela pode não existir ainda (migração pendente) → sem departamentos.
    return [];
  }
}

export type TaskVisibility = {
  canSeeAll: boolean;
  departmentIds: string[];
  /** Where a ser combinado (AND) com os demais filtros da listagem. */
  where: Prisma.ActivityWhereInput;
};

export async function getTaskVisibility(viewer: TaskViewer): Promise<TaskVisibility> {
  if (canSeeAllTasks(viewer)) {
    return { canSeeAll: true, departmentIds: [], where: {} };
  }

  const departmentIds =
    viewer.organizationId != null
      ? await getUserDepartmentIds(viewer.id, viewer.organizationId)
      : [];

  const or: Prisma.ActivityWhereInput[] = [{ userId: viewer.id }];
  if (departmentIds.length) {
    or.push({ departmentId: { in: departmentIds } });
  }

  return { canSeeAll: false, departmentIds, where: { OR: or } };
}

/**
 * Aba "Departamento" da agenda.
 * Quem vê todas as tarefas (admin/gestor) lista toda tarefa atribuída a
 * um departamento. Os demais listam só as dos departamentos em que são
 * membros. Sem vínculo, a aba fica vazia.
 */
export function departmentTasksWhere(
  visibility: TaskVisibility,
): Prisma.ActivityWhereInput {
  if (visibility.canSeeAll) return { departmentId: { not: null } };
  if (visibility.departmentIds.length) {
    return { departmentId: { in: visibility.departmentIds } };
  }
  return { id: "__none__" };
}

/**
 * Pode o `viewer` acessar (ver/editar/concluir) esta tarefa específica?
 * ADMIN/MANAGER sempre; dono da tarefa sempre; membro do departamento da
 * tarefa sempre. Caso contrário, não.
 */
export async function canAccessActivity(
  viewer: TaskViewer,
  activity: { userId: string | null; departmentId: string | null },
): Promise<boolean> {
  if (canSeeAllTasks(viewer)) return true;
  if (activity.userId && activity.userId === viewer.id) return true;
  if (activity.departmentId && viewer.organizationId != null) {
    const deptIds = await getUserDepartmentIds(viewer.id, viewer.organizationId);
    return deptIds.includes(activity.departmentId);
  }
  return false;
}
