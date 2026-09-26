import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getV2Agent } from "@/services/ai-v2/agents";
import { buildAgentRulesMarkdown, detectConfigGaps, type V2ExportNames } from "@/services/ai-v2/rules-export";

type Row = { id: string; name?: string | null };

const byId = (rows: Row[] | undefined) => Object.fromEntries((rows ?? []).map((r) => [r.id, r.name ?? ""]));

/** Nomes do que a configuração cita por id (departamento, agente, material…). */
async function loadNames(organizationId: string, agentId: string, config: V2AgentConfig): Promise<V2ExportNames> {
  const p = prisma as any;
  const docIds = [...new Set([
    ...(config.allowedKnowledgeDocIds ?? []),
    ...config.themes.flatMap((t) => [...(t.allowedKnowledgeDocIds ?? []), ...(t.knowledgeDocIds ?? [])]),
  ])];
  const safe = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const [departments, users, distributionRules, agents, models, docs, customFields, pipelines, tags, tabulations, attachments, channels] = await Promise.all([
    safe(p.department.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.user.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.distributionRule.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.aIAgentConfig.findMany({ where: { organizationId }, select: { id: true, engine: true, active: true, user: { select: { name: true } } } }), []),
    safe(p.messageTemplate.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.aIAgentKnowledgeDoc.findMany({ where: { organizationId, agentId, id: { in: docIds } }, select: { id: true, title: true, status: true, validUntil: true } }), []),
    safe(p.customField.findMany({ where: { organizationId }, select: { id: true, name: true, label: true } }), []),
    safe(p.pipeline.findMany({ where: { organizationId }, select: { name: true, stages: { select: { id: true, name: true } } } }), []),
    safe(Promise.resolve(p.tag?.findMany?.({ where: { organizationId }, select: { id: true, name: true } }) ?? []), []),
    safe(import("@/services/tabulations").then(({ listActiveTabulationLeaves }) => listActiveTabulationLeaves({ organizationId })), []),
    docIds.length === 0
      ? Promise.resolve([] as Array<{ docId: string; n: number }>)
      : safe(
          (prismaBase as unknown as { $queryRawUnsafe: <T>(q: string, ...v: unknown[]) => Promise<T> }).$queryRawUnsafe<Array<{ docId: string; n: number }>>(
            `SELECT "docId", COUNT(*)::int AS n FROM "ai_v2_material_attachments" WHERE "organizationId" = $1 AND "docId" = ANY($2::text[]) GROUP BY "docId"`,
            organizationId, docIds,
          ),
          [] as Array<{ docId: string; n: number }>,
        ),
    safe(p.channel.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
  ]);
  const attachmentCount = new Map((attachments as Array<{ docId: string; n: number }>).map((a) => [a.docId, Number(a.n)]));
  return {
    departments: byId(departments),
    users: byId(users),
    distributionRules: byId(distributionRules),
    aiAgents: Object.fromEntries((agents as Array<{ id: string; engine: string; active: boolean; user?: { name?: string } }>).map((a) => [a.id, { name: a.user?.name ?? a.id, engine: a.engine, active: a.active }])),
    messageModels: byId(models),
    docs: Object.fromEntries((docs as Array<{ id: string; title: string; status: string; validUntil: Date | null }>).map((d) => [d.id, {
      title: d.title,
      status: d.status,
      validUntil: d.validUntil ? new Date(d.validUntil).toISOString() : null,
      attachments: attachmentCount.get(d.id) ?? 0,
    }])),
    customFields: Object.fromEntries((customFields as Array<{ id: string; name: string; label?: string | null }>).map((f) => [f.id, f.label || f.name])),
    tabulations: Object.fromEntries((tabulations as Array<{ id: string; path: string; departmentName: string }>).map((t) => [t.id, `${t.departmentName} › ${t.path}`])),
    stages: Object.fromEntries((pipelines as Array<{ name: string; stages: Row[] }>).flatMap((pl) => pl.stages.map((s) => [s.id, `${pl.name} › ${s.name}`]))),
    tags: byId(tags as Row[]),
    channels: byId(channels as Row[]),
  };
}

/**
 * Regras do agente para revisar ou analisar gaps.
 * ?version=published|draft (padrão: published) · ?format=md|json (padrão: md).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const url = new URL(request.url);
      const version = url.searchParams.get("version") === "draft" ? "draft" : "published";
      const format = url.searchParams.get("format") === "json" ? "json" : "md";
      const organizationId = r.session.user.organizationId!;
      const agent = await getV2Agent(id, organizationId);
      if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });
      const config = version === "draft" ? agent.draftConfig ?? agent.publishedConfig : agent.publishedConfig;
      const versionLabel = version === "draft" ? "rascunho" : `publicada v${agent.lastVersionNumber}`;
      const names = await loadNames(organizationId, agent.id, config);
      const slug = (agent.name || "agente").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agente";
      const date = new Date().toISOString().slice(0, 10);
      const fileBase = `regras-${slug}-${version === "draft" ? "rascunho" : `v${agent.lastVersionNumber}`}-${date}`;

      if (format === "json") {
        const body = JSON.stringify({ agent: agent.name, agentId: agent.id, version: versionLabel, gaps: detectConfigGaps(config, names, { agentId: agent.id, version }), names, config }, null, 2);
        return new NextResponse(body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${fileBase}.json"`,
          },
        });
      }
      const markdown = buildAgentRulesMarkdown({ config, names, agentName: agent.name, version: versionLabel, agentId: agent.id, versionKind: version });
      return new NextResponse(markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileBase}.md"`,
        },
      });
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/export]", err);
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao exportar." }, { status: 500 });
    }
  });
}
