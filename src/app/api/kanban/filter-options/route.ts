import { NextResponse } from "next/server";

import { userOrgFilter, withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

/**
 * Metadados para alimentar o painel de filtros do Kanban em uma única chamada.
 * Retorna pipelines+stages, usuários ativos, tags, custom fields (deal e
 * contact) e os `source` distintos dos contatos da org.
 */
export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const orgId = getOrgIdOrThrow();
      const [pipelines, users, tags, customFields, sourceRows, utmSourceRows, lossReasonCatalog] = await Promise.all([
        prisma.pipeline.findMany({
          where: { archivedAt: null },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            slug: true,
            number: true,
            stages: {
              orderBy: { position: "asc" },
              select: { id: true, name: true, slug: true, number: true, color: true, position: true },
            },
          },
        }),
        // Bug 23/mai/26: o `where` so tinha `isErased: false`, sem filtro
        // de organizationId. Como User NAO esta em SCOPED_MODELS da Prisma
        // Extension (precisa funcionar sem ctx pra login/jwt), a filtragem
        // por org aqui eh MANUAL e OBRIGATORIA — sem ela, o painel de
        // filtros do Kanban listava users de TODAS as orgs do cluster
        // (vazamento cross-tenant grave). Fix: alinhar com /api/users
        // (type: HUMAN + userOrgFilter). isErased mantido pra ocultar
        // contas anonimizadas (LGPD/erasure).
        prisma.user.findMany({
          where: {
            isErased: false,
            type: "HUMAN",
            ...userOrgFilter(session),
          },
          orderBy: { name: "asc" },
          select: { id: true, name: true, avatarUrl: true, role: true, type: true },
        }),
        prisma.tag.findMany({
          orderBy: { name: "asc" },
          select: { id: true, name: true, color: true },
        }),
        prisma.customField.findMany({
          where: { entity: { in: ["deal", "contact"] } },
          orderBy: { label: "asc" },
          select: { id: true, name: true, label: true, type: true, options: true, entity: true },
        }),
        prisma.$queryRaw<{ source: string }[]>`
          SELECT DISTINCT source FROM contacts
          WHERE "organizationId" = ${orgId}
            AND source IS NOT NULL
            AND source <> ''
          LIMIT 200
        `,
        prisma.$queryRaw<{ ad_utm_source: string }[]>`
          SELECT DISTINCT ad_utm_source FROM contacts
          WHERE "organizationId" = ${orgId}
            AND ad_utm_source IS NOT NULL
            AND ad_utm_source <> ''
          LIMIT 200
        `,
        prisma.lossReason.findMany({
          where: { isActive: true },
          orderBy: { position: "asc" },
          select: { label: true },
        }),
      ]);

      const dealCustomFields = customFields.filter((cf) => cf.entity === "deal");
      const contactCustomFields = customFields.filter((cf) => cf.entity === "contact");

      const lossReasons = Array.from(
        new Set(lossReasonCatalog.map((r) => r.label).filter((r) => !!r.trim())),
      );

      return NextResponse.json({
        pipelines,
        users,
        tags,
        dealCustomFields,
        contactCustomFields,
        sources: sourceRows
          .map((s) => s.source?.trim())
          .filter((s): s is string => !!s)
          .sort((a, b) => a.localeCompare(b, "pt-BR")),
        utmSources: utmSourceRows
          .map((s) => s.ad_utm_source?.trim())
          .filter((s): s is string => !!s)
          .sort((a, b) => a.localeCompare(b, "pt-BR")),
        lossReasons,
      });
    } catch (e) {
      console.error(e);
      return NextResponse.json(
        { message: "Erro ao carregar opções de filtro." },
        { status: 500 },
      );
    }
  });
}
