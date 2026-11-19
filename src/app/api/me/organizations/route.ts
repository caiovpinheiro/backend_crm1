/**
 * GET /api/me/organizations — organizações para "Trocar de organização".
 *
 * Autenticado (cookie de sessão); não usa o `tenant-lookup` público. Lista
 * a org atual e as orgs onde existe uma conta elegível ao login com o MESMO
 * e-mail da conta da sessão (e-mail lido do banco, não do JWT).
 *
 * Resposta:
 * ```json
 * {
 *   "currentOrganizationId": "org_1",
 *   "organizations": [
 *     { "organizationId": "org_1", "slug": "acme", "name": "Acme", "logoUrl": null,
 *       "role": "ADMIN", "current": true, "linked": true },
 *     { "organizationId": "org_2", "slug": "beta", "name": "Beta", "logoUrl": null,
 *       "role": "MEMBER", "current": false, "linked": false }
 *   ]
 * }
 * ```
 * `linked: true` = a troca não pede senha (vínculo vigente, ver
 * `src/lib/auth/org-switch.ts`); `false` = a primeira troca pede a senha
 * (e o MFA) da conta de destino. Super-admin recebe só a lista vazia.
 */
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import {
  isLinkCurrent,
  linksOf,
  listEligibleTargets,
  loadSourceAccount,
} from "@/lib/auth/org-switch";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";

const log = getLogger("api/me/organizations");

export const dynamic = "force-dynamic";

export type SwitchableOrganization = {
  organizationId: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  role: string;
  current: boolean;
  linked: boolean;
};

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const { user } = r.session;

  try {
    // Cross-org por definição (contas do mesmo e-mail em outras orgs):
    // `prismaBase`, com o filtro de elegibilidade de `org-switch.ts`.
    const source = await loadSourceAccount(user.id);
    if (!source) {
      return NextResponse.json({
        currentOrganizationId: user.organizationId ?? null,
        organizations: [],
      });
    }

    const [currentOrg, targets, links] = await Promise.all([
      prismaBase.organization.findUnique({
        where: { id: source.organizationId },
        select: { id: true, slug: true, name: true, logoUrl: true },
      }),
      listEligibleTargets(source),
      linksOf(source),
    ]);

    const organizations: SwitchableOrganization[] = [];
    if (currentOrg) {
      organizations.push({
        organizationId: currentOrg.id,
        slug: currentOrg.slug,
        name: currentOrg.name,
        logoUrl: currentOrg.logoUrl ?? null,
        role: user.role ?? "MEMBER",
        current: true,
        linked: true,
      });
    }
    const others = targets
      .filter((t) => t.organizationId !== source.organizationId)
      .map<SwitchableOrganization>((t) => ({
        organizationId: t.organizationId,
        slug: t.organization.slug,
        name: t.organization.name,
        logoUrl: t.organization.logoUrl ?? null,
        role: t.role,
        current: false,
        linked: isLinkCurrent(links.get(t.id), source, t),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    organizations.push(...others);

    return NextResponse.json({
      currentOrganizationId: source.organizationId,
      organizations,
    });
  } catch (err) {
    log.error({ err }, "[GET /api/me/organizations] falhou");
    return NextResponse.json(
      { message: "Não foi possível carregar as organizações." },
      { status: 500 },
    );
  }
}
