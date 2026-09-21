import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAuth, requirePermission } from "@/lib/auth-helpers";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  const organizationId = r.session.user.organizationId!;
  const p = prisma as any;

  try {
    const [
      departments,
      distributionRules,
      users,
      aiAgents,
      messageTemplates,
      knowledgeDocs,
      channels,
      pipelines,
      customFields,
      products,
      whatsappTemplates,
    ] = await Promise.all([
      p.department.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      p.distributionRule.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      p.user.findMany({
        where: { organizationId, isErased: false, type: "HUMAN" },
        select: { id: true, name: true, type: true },
        orderBy: { name: "asc" },
      }),
      p.aIAgentConfig.findMany({
        where: { organizationId, engine: "simple" },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: "asc" } },
      }),
      p.messageTemplate.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      p.aIAgentKnowledgeDoc.findMany({
        where: { organizationId },
        select: { id: true, title: true },
        orderBy: { title: "asc" },
      }),
      p.channel.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      p.pipeline.findMany({
        where: { organizationId },
        include: { stages: { select: { id: true, name: true }, orderBy: { position: "asc" } } },
        orderBy: { name: "asc" },
      }),
      p.customField.findMany({
        where: { organizationId },
        select: { id: true, name: true, entity: true },
        orderBy: { name: "asc" },
      }),
      p.product.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
      p.whatsAppTemplateConfig.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const aiAgentCatalog = aiAgents.map((a: any) => ({ id: a.id, name: a.user?.name ?? "" }));

    return NextResponse.json({
      departments,
      distributionRules,
      users,
      aiAgents: aiAgentCatalog,
      messageTemplates,
      knowledgeDocs,
      channels,
      pipelines,
      contactCustomFields: customFields.filter((f: any) => f.entity === "CONTACT"),
      dealCustomFields: customFields.filter((f: any) => f.entity === "DEAL"),
      products,
      whatsappTemplates,
    });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/catalogs]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao carregar catálogos." },
      { status: 500 },
    );
  }
}
