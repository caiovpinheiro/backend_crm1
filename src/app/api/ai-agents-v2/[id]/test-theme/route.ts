import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { getV2Agent } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { explainV2ThemeRecognition } from "@/services/ai-v2/theme-semantic";

/**
 * Testar reconhecimento de assunto: qual assunto uma mensagem pegaria.
 * Aceita os assuntos da tela (ainda não salvos) para testar enquanto edita.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json().catch(() => ({}))) as { message?: string; themes?: unknown };
    const message = body.message?.trim() ?? "";
    if (!message) return NextResponse.json({ message: "Escreva uma mensagem para testar." }, { status: 400 });

    const agent = await getV2Agent(id, r.session.user.organizationId!);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });

    const base = agent.draftConfig ?? agent.publishedConfig;
    let config = base;
    if (Array.isArray(body.themes)) {
      try {
        config = normalizeV2Config({ ...base, themes: body.themes });
      } catch {
        return NextResponse.json({ message: "Algum assunto está incompleto. Confira nome e instruções." }, { status: 400 });
      }
    }

    const apiKey = await tryGetAgentApiKey(id);
    const result = await explainV2ThemeRecognition({ config, message, apiKey });
    return NextResponse.json({
      themeId: result.selection.theme?.id ?? null,
      themeName: result.selection.theme?.name ?? null,
      method: result.selection.method,
      similarity: result.selection.similarity ?? null,
      ranking: result.ranking,
      minSimilarity: result.minSimilarity,
      semantic: !!apiKey,
    });
  } catch (err) {
    console.error("[POST /api/ai-agents-v2/[id]/test-theme]", err);
    return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao testar o reconhecimento." }, { status: 500 });
  }
}
