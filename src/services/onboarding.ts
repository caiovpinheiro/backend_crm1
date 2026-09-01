import { UserRole } from "@prisma/client";
import { hash } from "bcryptjs";

import {
  ensureSystemPresetRoles,
  syncUserRoleAssignment,
} from "@/lib/authz/sync-user-role";
import { prismaBase } from "@/lib/prisma-base";
import { nextUserNumber } from "@/lib/public-id";
import { logAudit } from "@/lib/audit/log";
import { nextPipelineNumber, TERMINAL_STAGES } from "@/services/pipelines";
import {
  PIPELINE_TEMPLATES,
  type PipelineTemplateId,
} from "@/lib/onboarding-templates";
import { buildTenantUrl } from "@/lib/tenant-url";
import { slugify } from "@/lib/utils";
import { issueEmailVerification } from "@/services/email-verification";
import {
  acceptInvite,
  issueOrganizationInvite,
  loadInviteByRawToken,
} from "@/services/invites";

/**
 * Logica do wizard de onboarding. Opera com `prismaBase` porque:
 *   1. Alguns passos rodam ANTES do user existir (validate / createUser).
 *   2. O usuario criado durante o wizard so vira session no proximo request,
 *      entao o AsyncLocalStorage pode nao ter orgId pra alguns handlers.
 *   3. Todas as operacoes sao gatteadas por um token de convite valido.
 *
 * Cada helper valida o token e a org ANTES de tocar no db, e todas as
 * entidades criadas levam `organizationId` explicito.
 */

export type InviteLookup = {
  invite: {
    id: string;
    email: string;
    role: UserRole;
    expiresAt: Date;
    acceptedAt: Date | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    industry: string | null;
    size: string | null;
    phone: string | null;
    logoUrl: string | null;
    primaryColor: string | null;
    status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    onboardingCompletedAt: Date | null;
  };
};

async function loadInvite(token: string): Promise<InviteLookup> {
  const invite = await loadInviteByRawToken(token);
  return {
    invite: {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt,
    },
    organization: {
      id: invite.organization.id,
      name: invite.organization.name,
      slug: invite.organization.slug,
      industry: invite.organization.industry,
      size: invite.organization.size,
      phone: invite.organization.phone,
      logoUrl: invite.organization.logoUrl,
      primaryColor: invite.organization.primaryColor,
      status: invite.organization.status,
      onboardingCompletedAt: invite.organization.onboardingCompletedAt,
    },
  };
}

export async function validateOnboardingToken(token: string) {
  return loadInvite(token);
}

export async function updateOrganizationBasics(
  organizationId: string,
  input: {
    name?: string;
    industry?: string | null;
    size?: string | null;
    phone?: string | null;
  },
): Promise<void> {
  const org = await prismaBase.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });
  if (!org) throw new Error("Organização não encontrada.");
  await prismaBase.organization.update({
    where: { id: organizationId },
    data: {
      name: input.name?.trim() || org.name,
      industry: input.industry?.trim() || null,
      size: input.size?.trim() || null,
      phone: input.phone?.trim() || null,
    },
  });
}

export async function createAdminFromInvite(
  token: string,
  input: { name: string; email: string; password: string },
): Promise<{ userId: string; organizationId: string; email: string }> {
  const { invite, organization } = await loadInvite(token);
  if (invite.role !== UserRole.ADMIN) {
    throw new Error("Este convite não é pra admin inicial.");
  }
  const email = input.email.trim().toLowerCase();
  if (invite.email.toLowerCase() !== email) {
    throw new Error("Use o mesmo email do convite.");
  }
  const accepted = await acceptInvite({
    token,
    name: input.name,
    password: input.password,
  });
  return {
    userId: accepted.userId,
    organizationId: organization.id,
    email: accepted.email,
  };
}

export async function updateBranding(
  organizationId: string,
  input: { logoUrl?: string | null; primaryColor?: string | null },
): Promise<void> {
  await prismaBase.organization.update({
    where: { id: organizationId },
    data: {
      logoUrl: input.logoUrl ?? null,
      primaryColor: input.primaryColor?.trim() || "#1e3a8a",
    },
  });
}

/**
 * Atualiza apenas o `logoUrl` da organização (ícone da empresa), sem
 * tocar em `primaryColor`. Usado pela navrail para trocar/remover o ícone
 * fora do fluxo de onboarding. Passe `null` para remover.
 */
export async function setOrganizationLogo(
  organizationId: string,
  logoUrl: string | null,
): Promise<void> {
  await prismaBase.organization.update({
    where: { id: organizationId },
    data: { logoUrl },
  });
}

export async function applyPipelineTemplate(
  organizationId: string,
  templateId: PipelineTemplateId,
): Promise<{ pipelineId: string }> {
  const template = PIPELINE_TEMPLATES[templateId];
  if (!template) throw new Error("Template inválido.");

  const result = await prismaBase.$transaction(async (tx) => {
    // Se a org ja tem um default, nao sobrescreve — o wizard pode ser
    // re-executado em cenarios de recuperacao.
    const existingDefault = await tx.pipeline.findFirst({
      where: { organizationId, isDefault: true },
      select: { id: true },
    });
    if (existingDefault) return existingDefault;

    const number = await nextPipelineNumber(organizationId, tx);
    const pipeline = await tx.pipeline.create({
      data: {
        organizationId,
        name: template.pipelineName,
        slug: slugify(template.pipelineName) || "pipeline",
        number,
        isDefault: true,
        stages: {
          create: [
            ...template.stages.map((s, i) => ({
              organizationId,
              name: s.name,
              slug: slugify(s.name) || `stage-${s.position}`,
              number: i + 1,
              position: s.position,
              color: s.color,
              winProbability: s.winProbability,
              rottingDays: s.rottingDays,
              isIncoming: s.isIncoming ?? false,
            })),
            // Terminais fixos (estilo Kommo) fecham todo pipeline.
            ...TERMINAL_STAGES.map((s, i) => ({
              ...s,
              organizationId,
              number: template.stages.length + i + 1,
              position: template.stages.length + i,
            })),
          ],
        },
      },
      select: { id: true },
    });

    if (template.lossReasons.length) {
      await tx.lossReason.createMany({
        data: template.lossReasons.map((lr) => ({
          organizationId,
          label: lr.label,
          position: lr.position,
        })),
      });
    }

    if (template.customFields.length) {
      await tx.customField.createMany({
        data: template.customFields.map((cf) => ({
          organizationId,
          name: cf.name,
          label: cf.label,
          type: cf.type,
          options: cf.options ?? [],
          required: cf.required ?? false,
          entity: cf.entity,
          showInInboxLeadPanel: cf.showInInboxLeadPanel ?? false,
          inboxLeadPanelOrder: cf.inboxLeadPanelOrder ?? null,
        })),
      });
    }

    if (template.quickReplies.length) {
      await tx.quickReply.createMany({
        data: template.quickReplies.map((qr) => ({
          organizationId,
          title: qr.title,
          content: qr.content,
          category: qr.category ?? null,
          position: qr.position,
        })),
      });
    }

    return pipeline;
  });

  return { pipelineId: result.id };
}

export async function inviteTeamMembers(
  organizationId: string,
  createdById: string,
  members: { email: string; role: UserRole }[],
): Promise<{ created: number; emails: string[] }> {
  const emails: string[] = [];
  for (const m of members) {
    const email = m.email.trim().toLowerCase();
    if (!email) continue;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    if (m.role === UserRole.ADMIN) continue;
    try {
      await issueOrganizationInvite({
        organizationId,
        email,
        role: m.role,
        createdById,
      });
      emails.push(email);
    } catch {
      // E-mail já na org ou inválido — segue os demais.
    }
  }
  return { created: emails.length, emails };
}

export async function completeOnboarding(organizationId: string): Promise<void> {
  await prismaBase.organization.update({
    where: { id: organizationId },
    data: { onboardingCompletedAt: new Date() },
  });
}

/**
 * Signup self-service (sem convite). Cria Organization + User(ADMIN)
 * numa unica transacao. Chamado pelo endpoint publico POST /api/signup.
 *
 * O user nasce com `emailVerifiedAt` null. O caller deve mandar o
 * admin confirmar o código no e-mail antes do login.
 */
export async function signupOrganizationWithAdmin(input: {
  organizationName: string;
  slug: string;
  adminName: string;
  adminEmail: string;
  password: string;
}): Promise<{
  organizationId: string;
  organizationSlug: string;
  /** Alias de organizationSlug (contrato do redirect pós-signup). */
  slug: string;
  tenantUrl: string;
  userId: string;
  email: string;
  emailVerificationRequired: true;
  emailSent: boolean;
}> {
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

  const organizationName = input.organizationName.trim();
  const slug = input.slug.trim().toLowerCase();
  const adminName = input.adminName.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const password = input.password;

  if (organizationName.length < 2) {
    throw new Error("Nome da empresa inválido.");
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      "Slug inválido: use letras minúsculas, números e hífens (2-40 caracteres).",
    );
  }
  if (adminName.length < 2) throw new Error("Informe um nome válido.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw new Error("Email inválido.");
  }
  if (password.length < 8) {
    throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  }

  // Checagens fora da transacao pra dar erro amigavel antes do
  // trabalho pesado. A transacao abaixo cobre a condicao de corrida.
  const [existingSlug, existingUser] = await Promise.all([
    prismaBase.organization.findUnique({
      where: { slug },
      select: { id: true },
    }),
    prismaBase.user.findFirst({
      where: { email: adminEmail, isSuperAdmin: true, organizationId: null },
      select: { id: true },
    }),
  ]);
  if (existingSlug) throw new Error("Slug já em uso por outra organização.");
  if (existingUser) throw new Error("Já existe uma conta com este email.");

  const hashedPassword = await hash(password, 12);

  try {
    const result = await prismaBase.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: organizationName,
          slug,
          status: "ACTIVE",
        },
        select: { id: true, slug: true },
      });

      const user = await tx.user.create({
        data: {
          name: adminName,
          email: adminEmail,
          hashedPassword,
          role: UserRole.ADMIN,
          organizationId: org.id,
          number: await nextUserNumber(org.id, tx),
        },
        select: { id: true },
      });

      await tx.organization.update({
        where: { id: org.id },
        data: { createdById: user.id },
      });

      // RBAC: presets + assignment do admin — sem isso `can()` barra tudo.
      await ensureSystemPresetRoles(tx, org.id);
      await syncUserRoleAssignment(tx, {
        userId: user.id,
        organizationId: org.id,
        role: UserRole.ADMIN,
      });

      return { org, user };
    });

    await logAudit({
      entity: "organization",
      action: "create",
      entityId: result.org.id,
      organizationId: result.org.id,
      actorId: result.user.id,
      actorEmail: adminEmail,
      after: {
        id: result.org.id,
        name: organizationName,
        slug: result.org.slug,
        status: "ACTIVE",
      },
      metadata: { source: "registration" },
    });

    const verify = await issueEmailVerification({
      userId: result.user.id,
      email: adminEmail,
      organizationName,
    });

    return {
      organizationId: result.org.id,
      organizationSlug: result.org.slug,
      slug: result.org.slug,
      tenantUrl: buildTenantUrl(result.org.slug),
      userId: result.user.id,
      email: adminEmail,
      emailVerificationRequired: true as const,
      emailSent: verify.sent,
    };
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      // Unique violation — mensagem amigavel em vez de vazar o erro do
      // Prisma. Pode ser slug ou email caindo em race condition.
      throw new Error("Slug ou email já em uso.");
    }
    throw e;
  }
}

export async function acceptMemberInvite(input: {
  token: string;
  name: string;
  password: string;
}): Promise<{ userId: string; email: string; organizationSlug: string }> {
  return acceptInvite(input);
}
