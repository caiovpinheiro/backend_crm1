import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { searchV2Knowledge } from "@/services/ai-v2/tools";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      await ensureV2AgentSchema();
      const body = (await request.json()) as {
        query?: string;
        allowedDocIds?: string[];
      };
      const query = body.query?.trim() ?? "";
      if (!query) {
        return NextResponse.json({ message: "Escreva uma pergunta para testar a busca." }, { status: 400 });
      }

      const agent = await getV2Agent(id, r.session.user.organizationId!);
      if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });

      const configToTest = agent.draftConfig ?? agent.publishedConfig;
      const allowedDocIds = Array.isArray(body.allowedDocIds) && body.allowedDocIds.length > 0
        ? body.allowedDocIds
        : configToTest.allowedKnowledgeDocIds ?? [];

      const apiKey = await tryGetAgentApiKey(id);
      if (!apiKey) {
        return NextResponse.json(
          { ok: false, code: "NO_OPENAI_KEY", message: "Configure uma chave válida do modelo para testar a busca." },
          { status: 400 },
        );
      }

      const result = await searchV2Knowledge({
        agentId: id,
        apiKey,
        query,
        allowedDocIds,
        limit: 5,
      });

      return NextResponse.json({
        query: result.query,
        chunks: result.chunks,
      });
    } catch (err) {
      console.error("[POST /api/ai-agents-v2/[id]/test-search]", err);
      return NextResponse.json(
        { message: err instanceof Error ? err.message : "Erro ao testar busca de materiais." },
        { status: 500 },
      );
    }
  });
}
