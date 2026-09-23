import type { ActivityType, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getRequestContext } from "@/lib/request-context";

const ACTIVITY_TYPES: ActivityType[] = [
  "CALL",
  "EMAIL",
  "MEETING",
  "TASK",
  "NOTE",
  "WHATSAPP",
  "OTHER",
];

export function isValidActivityType(v: string): v is ActivityType {
  return ACTIVITY_TYPES.includes(v as ActivityType);
}

export type GetActivitiesParams = {
  dealId?: string;
  contactId?: string;
  userId?: string;
  departmentId?: string;
  type?: ActivityType;
  completed?: boolean;
  page?: number;
  perPage?: number;
  /**
   * Filtro extra de visibilidade (por departamento/dono), combinado via
   * AND com os demais. Vem de `getTaskVisibility()`.
   */
  viewerWhere?: Prisma.ActivityWhereInput;
};

const listInclude = {
  user: { select: { id: true, name: true, email: true, avatarUrl: true } },
  createdBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
  startedBy: { select: { id: true, name: true, avatarUrl: true } },
  completedBy: { select: { id: true, name: true, avatarUrl: true } },
  department: { select: { id: true, name: true, color: true, icon: true } },
  contact: { select: { id: true, name: true, email: true } },
  deal: { select: { id: true, title: true, stageId: true } },
} satisfies Prisma.ActivityInclude;

export async function getActivityById(id: string) {
  return prisma.activity.findUnique({
    where: { id },
    include: listInclude,
  });
}

export async function getActivities(params: GetActivitiesParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;

  const where: Prisma.ActivityWhereInput = {};

  if (params.dealId) where.dealId = params.dealId;
  if (params.contactId) where.contactId = params.contactId;
  if (params.userId) where.userId = params.userId;
  if (params.departmentId) where.departmentId = params.departmentId;
  if (params.type) where.type = params.type;
  if (params.completed !== undefined) where.completed = params.completed;
  if (params.viewerWhere && Object.keys(params.viewerWhere).length > 0) {
    where.AND = [params.viewerWhere];
  }

  const [items, total] = await Promise.all([
    prisma.activity.findMany({
      where,
      skip,
      take: perPage,
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
      include: listInclude,
    }),
    prisma.activity.count({ where }),
  ]);

  return { items, total, page, perPage };
}

export type CreateActivityInput = {
  type: ActivityType;
  title: string;
  description?: string | null;
  completed?: boolean;
  scheduledAt?: Date | string | null;
  completedAt?: Date | string | null;
  contactId?: string | null;
  dealId?: string | null;
  /** Responsável usuário (opcional se atribuída a departamento). */
  userId?: string | null;
  /** Responsável departamento (tarefa compartilhada). */
  departmentId?: string | null;
  /** Quem criou a tarefa (distinto do responsável). Null = sistema/automação. */
  createdById?: string | null;
};

/**
 * Garante que o departamento pertence à org atual. `Department` NÃO é um
 * model auto-escopado pela extension, então filtramos por organizationId
 * explicitamente (evita atribuir tarefa a departamento de outra org).
 */
async function assertDepartmentInOrg(departmentId: string): Promise<boolean> {
  const orgId = getRequestContext()?.organizationId ?? undefined;
  const dept = await prisma.department.findFirst({
    where: { id: departmentId, ...(orgId ? { organizationId: orgId } : {}) },
    select: { id: true },
  });
  return !!dept;
}

export async function createActivity(data: CreateActivityInput) {
  const title = data.title.trim();
  if (!title) throw new Error("INVALID_TITLE");

  const departmentId = data.departmentId ?? null;
  if (departmentId && !(await assertDepartmentInOrg(departmentId))) {
    throw new Error("INVALID_DEPARTMENT");
  }

  // Pelo menos um responsável: se nada informado, cai como não-atribuída
  // (permitido — ex.: tarefa de departamento sem depto ainda seria raro).
  if (!departmentId && (data.userId === null || data.userId === undefined)) {
    throw new Error("MISSING_ASSIGNEE");
  }

  return prisma.activity.create({
    data: withOrgFromCtx({
      type: data.type,
      title,
      description: data.description === undefined ? undefined : data.description,
      completed: data.completed,
      scheduledAt: data.scheduledAt === undefined ? undefined : data.scheduledAt,
      completedAt: data.completedAt === undefined ? undefined : data.completedAt,
      contactId: data.contactId === undefined ? undefined : data.contactId,
      dealId: data.dealId === undefined ? undefined : data.dealId,
      userId: data.userId ?? null,
      departmentId,
      createdById: data.createdById === undefined ? undefined : data.createdById,
    }),
    include: listInclude,
  });
}

export type UpdateActivityInput = {
  type?: ActivityType;
  title?: string;
  description?: string | null;
  completed?: boolean;
  scheduledAt?: Date | string | null;
  completedAt?: Date | string | null;
  contactId?: string | null;
  dealId?: string | null;
  /** Reatribuir para outro usuário (ou null p/ liberar). */
  userId?: string | null;
  /** Reatribuir para um departamento (ou null p/ remover). */
  departmentId?: string | null;
  /** Quem está executando. Null libera. O id vem da sessão, não do cliente. */
  startedById?: string | null;
  startedAt?: Date | string | null;
  /** Quem concluiu. O id vem da sessão, não do cliente. */
  completedById?: string | null;
};

export async function updateActivity(id: string, data: UpdateActivityInput) {
  const payload: Prisma.ActivityUpdateInput = {};

  if (data.title !== undefined) {
    const title = data.title.trim();
    if (!title) throw new Error("INVALID_TITLE");
    payload.title = title;
  }
  if (data.type !== undefined) payload.type = data.type;
  if (data.description !== undefined) payload.description = data.description;
  if (data.completed !== undefined) payload.completed = data.completed;
  if (data.scheduledAt !== undefined) payload.scheduledAt = data.scheduledAt;
  if (data.completedAt !== undefined) payload.completedAt = data.completedAt;
  if (data.contactId !== undefined) {
    payload.contact =
      data.contactId === null ? { disconnect: true } : { connect: { id: data.contactId } };
  }
  if (data.dealId !== undefined) {
    payload.deal = data.dealId === null ? { disconnect: true } : { connect: { id: data.dealId } };
  }
  if (data.userId !== undefined) {
    payload.user =
      data.userId === null ? { disconnect: true } : { connect: { id: data.userId } };
  }
  if (data.departmentId !== undefined) {
    if (data.departmentId !== null && !(await assertDepartmentInOrg(data.departmentId))) {
      throw new Error("INVALID_DEPARTMENT");
    }
    payload.department =
      data.departmentId === null
        ? { disconnect: true }
        : { connect: { id: data.departmentId } };
  }
  if (data.startedAt !== undefined) payload.startedAt = data.startedAt;
  if (data.startedById !== undefined) {
    payload.startedBy =
      data.startedById === null
        ? { disconnect: true }
        : { connect: { id: data.startedById } };
  }
  if (data.completedById !== undefined) {
    payload.completedBy =
      data.completedById === null
        ? { disconnect: true }
        : { connect: { id: data.completedById } };
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("EMPTY_UPDATE");
  }

  return prisma.activity.update({
    where: { id },
    data: payload,
    include: listInclude,
  });
}

export async function deleteActivity(id: string) {
  await prisma.activity.delete({ where: { id } });
}

export async function toggleActivityComplete(id: string) {
  const current = await prisma.activity.findUnique({ where: { id } });
  if (!current) throw new Error("NOT_FOUND");

  const completed = !current.completed;
  return prisma.activity.update({
    where: { id },
    data: {
      completed,
      completedAt: completed ? new Date() : null,
    },
    include: listInclude,
  });
}

export async function getUpcomingActivities(userId: string, limit: number) {
  const take = Math.min(50, Math.max(1, limit));

  return prisma.activity.findMany({
    where: {
      userId,
      completed: false,
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
    take,
    include: listInclude,
  });
}
