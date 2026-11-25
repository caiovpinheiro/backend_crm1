import { NextResponse } from "next/server";

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { rankTemplates, type TemplateCandidate } from "@/services/ai-v2/agenda";
import { chooseTemplate } from "@/services/ai-v2/agenda-worker";

const log = getLogger("api/ai-agents-v2/[id]/template-suggestions");

/**
 * Modelos da Meta liberados para agente, do mais ao menos adequado para um
 * envio automático (retomada, passo de follow-up). `recommended` é o que o
 * agente escolheria na hora do envio. Modelo com variável aparece, mas só
 * sai se a tela configurar os valores.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  let purpose = "";
  try {
    const body = (await request.json()) as { purpose?: unknown };
    purpose = typeof body?.purpose === "string" ? body.purpose.trim().slice(0, 400) : "";
  } catch {
    return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
  }
  return runInSessionContext(r.session, async () => {
    try {
      const agent = await prisma.aIAgentConfig.findUnique({
        where: { id },
        select: { simpleConfig: true, draftConfig: true },
      });
      if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });
      const rows = await prisma.whatsAppTemplateConfig.findMany({
        where: { agentEnabled: true, hiddenAt: null },
        select: { metaTemplateName: true, language: true, label: true, bodyPreview: true, hasVariables: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });
      const all: Array<TemplateCandidate & { hasVariables: boolean; label: string }> = rows.map((t) => ({
        name: t.metaTemplateName,
        language: t.language || "pt_BR",
        variables: [],
        label: t.label ?? "",
        hasVariables: t.hasVariables,
        ...(t.label ? { purpose: t.label } : {}),
        ...(t.bodyPreview ? { preview: t.bodyPreview } : {}),
      }));
      const ranked = rankTemplates(all, purpose) as typeof all;
      let recommended: string | null = null;
      const sendable = ranked.filter((t) => !t.hasVariables);
      if (sendable.length > 0) {
        let config;
        try {
          config = normalizeV2Config(agent.draftConfig ?? agent.simpleConfig);
        } catch {
          config = null;
        }
        const pick = config ? await chooseTemplate(config, id, sendable, purpose) : sendable[0];
        recommended = pick?.name ?? null;
      }
      return NextResponse.json({
        recommended,
        templates: ranked.map((t) => ({
          name: t.name,
          language: t.language,
          label: t.label,
          bodyPreview: t.preview ?? "",
          hasVariables: t.hasVariables,
        })),
      });
    } catch (err) {
      log.error({ err }, "[POST /api/ai-agents-v2/[id]/template-suggestions]");
      return NextResponse.json({ message: "Erro ao sugerir modelos." }, { status: 500 });
    }
  });
}
