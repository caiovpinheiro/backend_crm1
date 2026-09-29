import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { V2_MODELS } from "@/lib/ai-v2/models";

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
      contacts,
      tags,
      tabulationRows,
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
        select: { id: true, metaTemplateName: true, label: true },
        orderBy: { metaTemplateName: "asc" },
      }),
      p.contact.findMany({
        where: { organizationId },
        select: { id: true, name: true, phone: true, email: true },
        orderBy: { name: "asc" },
        take: 200,
      }),
      // Etiquetas são extras ("O que ele pode fazer"): falha aqui não derruba o catálogo.
      Promise.resolve(
        p.tag?.findMany?.({
          where: { organizationId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }) ?? [],
      ).catch(() => []),
      // Tabulações ("Começo e fim › Tabulação"): folhas ativas com o caminho
      // completo — as mesmas que o agente vê. Extras, mesma tolerância.
      import("@/services/tabulations")
        .then(({ listActiveTabulationLeaves }) => runInSessionContext(r.session, () => listActiveTabulationLeaves({ organizationId })))
        .catch(() => []),
    ]);

    const tabulations = (tabulationRows as Array<{ id: string; path: string; departmentName: string }>).map((t) => ({
      id: t.id,
      name: `${t.departmentName} › ${t.path}`,
    }));

    const aiAgentCatalog = aiAgents.map((a: any) => ({ id: a.id, name: a.user?.name ?? "" }));
    const whatsappTemplateCatalog = whatsappTemplates.map((t: any) => ({
      id: t.id,
      name: t.metaTemplateName || t.label || "Template",
    }));

    return NextResponse.json({
      departments,
      distributionRules,
      users,
      aiAgents: aiAgentCatalog,
      messageTemplates,
      knowledgeDocs,
      channels,
      pipelines,
      tags,
      tabulations,
      contactCustomFields: customFields.filter(
        (f: any) => typeof f.entity === "string" && f.entity.toLowerCase() === "contact",
      ),
      dealCustomFields: customFields.filter(
        (f: any) => typeof f.entity === "string" && f.entity.toLowerCase() === "deal",
      ),
      products,
      whatsappTemplates: whatsappTemplateCatalog,
      models: V2_MODELS.map((m) => ({
        id: m.id,
        name: m.label,
        provider: m.provider,
        hint: m.hint,
        inputPer1M: m.inputPer1M,
        outputPer1M: m.outputPer1M,
      })),
      contacts: contacts.map((c: any) => ({
        id: c.id,
        name: c.name || c.phone || c.email || c.id,
        phone: c.phone,
        email: c.email,
      })),
    });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/catalogs]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao carregar catálogos." },
      { status: 500 },
    );
  }
}
