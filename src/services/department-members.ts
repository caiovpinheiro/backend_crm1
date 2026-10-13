import { bumpResponseFamilies, RESPONSE_FAMILIES } from "@/lib/cache/response-families";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

/**
 * Membros de departamento (composição do time) — associação N:N entre
 * `User` e `Department`, puramente organizacional. NÃO concede acesso ao
 * inbox (isso continua em `AgentPermission.allowedDepartmentIds`).
 *
 * Espelha o padrão de `groups.ts` (GroupMember): modelo não-escopado,
 * então filtramos por `organizationId` explicitamente em toda operação.
 */

export type DepartmentMember = {
  id: string;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
};

async function assertDepartmentInOrg(departmentId: string, orgId: string) {
  const dept = await prisma.department.findFirst({
    where: { id: departmentId, organizationId: orgId },
    select: { id: true },
  });
  return !!dept;
}

export async function listDepartmentMembers(departmentId: string): Promise<DepartmentMember[]> {
  const orgId = getOrgIdOrThrow();
  const rows = await prisma.departmentMember.findMany({
    where: { departmentId, organizationId: orgId },
    select: {
      id: true,
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.id, user: r.user }));
}

export async function addDepartmentMember(departmentId: string, userId: string) {
  const orgId = getOrgIdOrThrow();
  if (!(await assertDepartmentInOrg(departmentId, orgId))) return null;

  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId: orgId, type: "HUMAN", isErased: false },
    select: { id: true },
  });
  if (!user) throw new Error("Usuário não encontrado nesta organização.");

  await prisma.departmentMember.upsert({
    where: { departmentId_userId: { departmentId, userId } },
    create: { departmentId, userId, organizationId: orgId },
    update: {},
  });
  await bumpResponseFamilies(orgId, RESPONSE_FAMILIES.departments);
  return listDepartmentMembers(departmentId);
}

export async function removeDepartmentMember(departmentId: string, userId: string) {
  const orgId = getOrgIdOrThrow();
  const deleted = await prisma.departmentMember.deleteMany({
    where: { departmentId, userId, organizationId: orgId },
  });
  if (deleted.count === 0) return null;
  await bumpResponseFamilies(orgId, RESPONSE_FAMILIES.departments);
  return { ok: true as const };
}

/**
 * Substitui o conjunto de membros do departamento pelos `userIds` dados
 * (usado no "salvar" do modal). Ignora ids inválidos/cross-org.
 */
export async function setDepartmentMembers(departmentId: string, userIds: string[]) {
  const orgId = getOrgIdOrThrow();
  if (!(await assertDepartmentInOrg(departmentId, orgId))) return null;

  const wanted = Array.from(new Set(userIds.filter((id) => typeof id === "string" && id)));
  const valid = wanted.length
    ? (
        await prisma.user.findMany({
          where: {
            id: { in: wanted },
            organizationId: orgId,
            type: "HUMAN",
            isErased: false,
          },
          select: { id: true },
        })
      ).map((u) => u.id)
    : [];
  const validSet = new Set(valid);

  await prisma.$transaction(async (tx) => {
    await tx.departmentMember.deleteMany({
      where: {
        departmentId,
        organizationId: orgId,
        ...(valid.length ? { userId: { notIn: valid } } : {}),
      },
    });
    if (validSet.size) {
      await tx.departmentMember.createMany({
        data: [...validSet].map((userId) => ({ departmentId, userId, organizationId: orgId })),
        skipDuplicates: true,
      });
    }
  });
  await bumpResponseFamilies(orgId, RESPONSE_FAMILIES.departments);

  return listDepartmentMembers(departmentId);
}
