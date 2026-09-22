import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { getModel } from "@/services/ai/provider";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { generateText } from "ai";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const agent = await getV2Agent(id, r.session.user.organizationId!);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });

    const config = agent.draftConfig ?? agent.publishedConfig;
    const apiKey = await tryGetAgentApiKey(id);
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "NO_KEY", message: "Este agente não tem chave OpenAI configurada." });
    }

    const model = getModel(config.model, apiKey);
    await generateText({
      model,
      messages: [{ role: "user", content: "Hi" }],
      maxOutputTokens: 16,
      maxRetries: 0,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/ai-agents-v2/[id]/validate-key]", err);
    const message = err instanceof Error ? err.message : "Erro ao validar chave.";
    return NextResponse.json({ ok: false, error: "INVALID_KEY", message }, { status: 200 });
  }
}
