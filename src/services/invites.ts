import { UserRole, type Prisma } from "@prisma/client";
import { hash } from "bcryptjs";

import {
  ensureSystemPresetRoles,
  syncUserRoleAssignment,
} from "@/lib/authz/sync-user-role";
import {
  CRM_ACTION_KEYS,
  getScopeGrants,
  mergeCrmActionGrantsForUser,
  setScopeGrantsForOrg,
  type CrmActionKey,
} from "@/lib/authz/scope-grants";
import { generateUrlToken, hashSecret } from "@/lib/auth/token-hash";
import { sendInviteEmail, sendWelcomeEmail } from "@/lib/mail/send";
import { prismaBase } from "@/lib/prisma-base";
import { nextUserNumber } from "@/lib/public-id";
import { logAudit } from "@/lib/audit/log";
import { buildTenantUrl } from "@/lib/tenant-url";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: "Administrador",
  MANAGER: "Gestor",
  MEMBER: "Membro",
};

export type PendingCrmActions = Partial<Record<CrmActionKey, boolean>>;

export type InvitePublicView = {
  invite: {
    email: string;
    role: UserRole;
    inviteeName: string | null;
    expiresAt: Date;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    primaryColor: string | null;
    logoUrl: string | null;
  };
};

function parsePendingCrmActions(raw: unknown): PendingCrmActions | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: PendingCrmActions = {};
  for (const key of CRM_ACTION_KEYS) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  return Object.keys(out).length ? out : null;
}

async function findInviteByRawToken(raw: string) {
  const tokenHash = hashSecret(raw);
  const byHash = await prismaBase.organizationInvite.findUnique({
    where: { tokenHash },
    include: { organization: true },
  });
  if (byHash) return byHash;
  return prismaBase.organizationInvite.findUnique({
    where: { token: raw },
    include: { organization: true },
  });
}

export async function loadInviteByRawToken(raw: string) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Token ausente.");
  }
  const invite = await findInviteByRawToken(raw);
  if (!invite) throw new Error("Convite inválido.");
  if (invite.acceptedAt) throw new Error("Convite já utilizado.");
  if (invite.revokedAt) throw new Error("Convite inválido.");
  if (invite.expiresAt.getTime() < Date.now()) {
    throw new Error("Convite expirado.");
  }
  if (invite.organization.status !== "ACTIVE") {
    throw new Error("Organização inativa.");
  }
  return invite;
}

export async function validateInviteToken(raw: string): Promise<InvitePublicView> {
  const invite = await loadInviteByRawToken(raw);
  return {
    invite: {
      email: invite.email,
      role: invite.role,
      inviteeName: invite.inviteeName,
      expiresAt: invite.expiresAt,
    },
    organization: {
      id: invite.organization.id,
      name: invite.organization.name,
      slug: invite.organization.slug,
      primaryColor: invite.organization.primaryColor,
      logoUrl: invite.organization.logoUrl,
    },
  };
}

async function revokeOpenInvitesForEmail(params: {
  organizationId: string;
  email: string;
}): Promise<void> {
  await prismaBase.organizationInvite.updateMany({
    where: {
      organizationId: params.organizationId,
      email: params.email,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date(), expiresAt: new Date() },
  });
}

export async function issueOrganizationInvite(params: {
  organizationId: string;
  email: string;
  role: UserRole;
  createdById: string;
  inviteeName?: string | null;
  pendingRoleId?: string | null;
  pendingCrmActions?: PendingCrmActions | null;
}): Promise<{
  id: string;
  email: string;
  expiresAt: Date;
  token: string;
  sent: boolean;
}> {
  const email = params.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Email inválido.");
  }

  const existingUser = await prismaBase.user.findFirst({
    where: { email, organizationId: params.organizationId, isErased: false },
    select: { id: true },
  });
  if (existingUser) {
    throw new Error("Já existe uma conta com este email nesta organização.");
  }

  const org = await prismaBase.organization.findUnique({
    where: { id: params.organizationId },
    select: { id: true, name: true, slug: true, status: true },
  });
  if (!org || org.status !== "ACTIVE") {
    throw new Error("Organização inativa.");
  }

  let pendingRoleId = params.pendingRoleId?.trim() || null;
  if (pendingRoleId) {
    const role = await prismaBase.role.findFirst({
      where: { id: pendingRoleId, organizationId: params.organizationId },
      select: { id: true },
    });
    if (!role) pendingRoleId = null;
  }

  const { raw, hash } = generateUrlToken();
  await revokeOpenInvitesForEmail({
    organizationId: params.organizationId,
    email,
  });

  const inviteeName = params.inviteeName?.trim() || null;
  const pendingCrm = params.pendingCrmActions ?? null;

  const inv = await prismaBase.organizationInvite.create({
    data: {
      organizationId: params.organizationId,
      email,
      role: params.role,
      token: null,
      tokenHash: hash,
      inviteeName,
      pendingRoleId,
      pendingCrmActions: pendingCrm
        ? (pendingCrm as Prisma.InputJsonValue)
        : undefined,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      createdById: params.createdById,
    },
  });

  await logAudit({
    entity: "organization",
    action: "invite_create",
    entityId: inv.id,
    organizationId: params.organizationId,
    actorId: params.createdById,
    after: {
      id: inv.id,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
    },
  });

  const inviteUrl = `${buildTenantUrl(org.slug)}/accept-invite?token=${encodeURIComponent(raw)}`;
  const mail = await sendInviteEmail({
    to: email,
    organizationName: org.name,
    inviteUrl,
    roleLabel: ROLE_LABEL[params.role],
  });

  return {
    id: inv.id,
    email: inv.email,
    expiresAt: inv.expiresAt,
    token: raw,
    sent: mail.sent,
  };
}

export async function resendOrganizationInvite(params: {
  organizationId: string;
  inviteId: string;
  actorId: string;
}): Promise<{ id: string; email: string; expiresAt: Date; sent: boolean }> {
  const prev = await prismaBase.organizationInvite.findFirst({
    where: {
      id: params.inviteId,
      organizationId: params.organizationId,
    },
  });
  if (!prev) throw new Error("Convite não encontrado.");
  if (prev.acceptedAt) throw new Error("Convite já utilizado.");

  const issued = await issueOrganizationInvite({
    organizationId: params.organizationId,
    email: prev.email,
    role: prev.role,
    createdById: params.actorId,
    inviteeName: prev.inviteeName,
    pendingRoleId: prev.pendingRoleId,
    pendingCrmActions: parsePendingCrmActions(prev.pendingCrmActions),
  });
  return {
    id: issued.id,
    email: issued.email,
    expiresAt: issued.expiresAt,
    sent: issued.sent,
  };
}

export async function listPendingInvites(organizationId: string) {
  return prismaBase.organizationInvite.findMany({
    where: {
      organizationId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      inviteeName: true,
      expiresAt: true,
      createdAt: true,
    },
  });
}

async function applyPendingRole(params: {
  tx: Prisma.TransactionClient;
  userId: string;
  organizationId: string;
  pendingRoleId: string | null;
  fallbackRole: UserRole;
  assignedById: string | null;
}): Promise<void> {
  await ensureSystemPresetRoles(params.tx, params.organizationId);
  await syncUserRoleAssignment(params.tx, {
    userId: params.userId,
    organizationId: params.organizationId,
    role: params.fallbackRole,
    assignedById: params.assignedById,
  });
  if (!params.pendingRoleId) return;

  const role = await params.tx.role.findFirst({
    where: { id: params.pendingRoleId, organizationId: params.organizationId },
    select: { id: true, systemPreset: true },
  });
  if (!role) return;

  if (
    role.systemPreset === "ADMIN" ||
    role.systemPreset === "MANAGER" ||
    role.systemPreset === "MEMBER"
  ) {
    await params.tx.user.update({
      where: { id: params.userId },
      data: { role: role.systemPreset },
    });
    await syncUserRoleAssignment(params.tx, {
      userId: params.userId,
      organizationId: params.organizationId,
      role: role.systemPreset,
      assignedById: params.assignedById,
    });
    return;
  }

  await params.tx.user.update({
    where: { id: params.userId },
    data: { role: UserRole.MEMBER },
  });
  await params.tx.userRoleAssignment.deleteMany({
    where: { userId: params.userId, organizationId: params.organizationId },
  });
  await params.tx.userRoleAssignment.create({
    data: {
      userId: params.userId,
      roleId: role.id,
      organizationId: params.organizationId,
      assignedById: params.assignedById,
    },
  });
}

export async function acceptInvite(input: {
  token: string;
  name: string;
  password: string;
}): Promise<{ userId: string; email: string; organizationSlug: string }> {
  const invite = await loadInviteByRawToken(input.token);
  const organization = invite.organization;
  const name = (input.name.trim() || invite.inviteeName || "").trim();
  if (name.length < 2) throw new Error("Informe um nome válido.");
  if (input.password.length < 8) {
    throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  }
  const email = invite.email.toLowerCase();
  const existing = await prismaBase.user.findFirst({
    where: { email, organizationId: organization.id },
    select: { id: true },
  });
  if (existing) {
    throw new Error("Já existe uma conta com este email nesta organização.");
  }

  const hashedPassword = await hash(input.password, 12);
  const pendingCrm = parsePendingCrmActions(invite.pendingCrmActions);

  const result = await prismaBase.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        hashedPassword,
        role: invite.role,
        organizationId: organization.id,
        number: await nextUserNumber(organization.id, tx),
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await applyPendingRole({
      tx,
      userId: user.id,
      organizationId: organization.id,
      pendingRoleId: invite.pendingRoleId,
      fallbackRole: invite.role,
      assignedById: invite.createdById,
    });
    await tx.organizationInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedById: user.id },
    });
    return user;
  });

  if (pendingCrm && invite.role !== UserRole.ADMIN) {
    const current = await getScopeGrants(organization.id);
    const next = mergeCrmActionGrantsForUser(current, result.id, pendingCrm);
    await setScopeGrantsForOrg(organization.id, next);
  }

  await logAudit({
    entity: "organization",
    action: "invite_accept",
    entityId: invite.id,
    organizationId: organization.id,
    actorId: result.id,
    actorEmail: email,
    after: { userId: result.id, role: invite.role },
  });

  await sendWelcomeEmail({
    to: email,
    name,
    organizationName: organization.name,
    loginUrl: `${buildTenantUrl(organization.slug)}/login`,
  });

  return {
    userId: result.id,
    email,
    organizationSlug: organization.slug,
  };
}
