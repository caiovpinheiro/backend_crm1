/**
 * Dados básicos da organização (nome, slug, marca, status) em memória do
 * processo — C1 da auditoria de banco (05/10): `organizations` tem 25
 * linhas e era lida a cada bootstrap do app, a cada execução de agente de
 * IA e a cada resolução da URL do tenant.
 *
 * 30 s por processo, com invalidação por versão quando a org é editada
 * (onboarding, marca, status). NÃO é fonte de autorização: quem barra
 * organização suspensa é o refresh do JWT (`lib/auth.ts`, que lê
 * `organization.status` direto do banco a cada 30 s por usuário). Aqui o
 * `status` é só o que a tela mostra — e também vale em no máximo 30 s.
 */
import {
  invalidateLocalVersioned,
  localVersioned,
} from "@/lib/cache/local-versioned";
import { prismaBase } from "@/lib/prisma-base";

const ORG_SUMMARY_FAMILY = "org_summary";
const ORG_SUMMARY_TTL_MS = 30_000;

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string | null;
  status: string;
  onboardingCompletedAt: Date | null;
};

const SUMMARY_SELECT = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  primaryColor: true,
  status: true,
  onboardingCompletedAt: true,
} as const;

/** `null` quando a organização não existe. Devolve cópia. */
export async function getOrganizationSummary(
  organizationId: string,
): Promise<OrganizationSummary | null> {
  const row = await localVersioned<OrganizationSummary | null>(
    {
      family: ORG_SUMMARY_FAMILY,
      scope: [organizationId],
      ttlMs: ORG_SUMMARY_TTL_MS,
    },
    () =>
      prismaBase.organization.findUnique({
        where: { id: organizationId },
        select: SUMMARY_SELECT,
      }),
  );
  return row ? { ...row } : null;
}

/** Chamar depois de qualquer `organization.update` dos campos acima. */
export async function invalidateOrganizationSummary(
  organizationId: string,
): Promise<void> {
  await invalidateLocalVersioned(ORG_SUMMARY_FAMILY, organizationId);
}
