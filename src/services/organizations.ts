import { OrgStatus, Prisma, UserRole } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";
import { logAudit } from "@/lib/audit/log";
import { issueOrganizationInvite } from "@/services/invites";

/**
 * Serviço global (super-admin only) de organizações. Usa `prismaBase`
 * — NAO passa pela Prisma Extension — porque super-admin precisa listar
 * e criar orgs cruzando tenants.
 *
 * Toda operação aqui deve ser gatteada por `requireSuperAdmin()` no
 * route handler. Nunca exponha funções deste arquivo pra rotas de
 * usuário comum.
 */

export type OrgListItem = {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  industry: string | null;
  size: string | null;
  onboardingCompletedAt: Date | null;
  createdAt: Date;
  userCount: number;
  contactCount: number;
};

export async function listOrganizations(params: {
  search?: string;
  status?: OrgStatus;
}): Promise<OrgListItem[]> {
  const where: Prisma.OrganizationWhereInput = {};
  if (params.status) where.status = params.status;
  if (params.search && params.search.trim()) {
    const q = params.search.trim();
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { slug: { contains: q, mode: "insensitive" } },
    ];
  }

  const orgs = await prismaBase.organization.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      industry: true,
      size: true,
      onboardingCompletedAt: true,
      createdAt: true,
      _count: {
        select: { users: true, contacts: true },
      },
    },
  });

  return orgs.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    status: o.status,
    industry: o.industry,
    size: o.size,
    onboardingCompletedAt: o.onboardingCompletedAt,
    createdAt: o.createdAt,
    userCount: o._count.users,
    contactCount: o._count.contacts,
  }));
}

export async function getOrganizationById(id: string) {
  return prismaBase.organization.findUnique({
    where: { id },
    include: {
      users: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isSuperAdmin: true,
          type: true,
          isErased: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
      invites: {
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          token: true,
          expiresAt: true,
          createdAt: true,
        },
      },
      _count: {
        select: {
          contacts: true,
          deals: true,
          pipelines: true,
          channels: true,
          conversations: true,
        },
      },
    },
  });
}

export async function updateOrganizationStatus(
  id: string,
  status: OrgStatus,
): Promise<void> {
  const before = await prismaBase.organization.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, status: true },
  });
  await prismaBase.organization.update({ where: { id }, data: { status } });
  await logAudit({
    entity: "organization",
    action: "update",
    entityId: id,
    organizationId: id,
    before: before ?? undefined,
    after: { ...before, status },
    metadata: { field: "status" },
  });
}

export async function createInviteForOrganization(params: {
  organizationId: string;
  email: string;
  role: UserRole;
  createdById: string;
}): Promise<{ id: string; token: string; expiresAt: Date; email: string; sent: boolean }> {
  return issueOrganizationInvite(params);
}
