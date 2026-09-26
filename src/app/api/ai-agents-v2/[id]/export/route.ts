import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { buildAgentRulesMarkdown, detectConfigGaps } from "@/services/ai-v2/rules-export";
import { loadExportNames } from "@/services/ai-v2/rules-export-names";

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
      const names = await loadExportNames(organizationId, agent.id, config);
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
