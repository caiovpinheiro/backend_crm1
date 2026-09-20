import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { callV2LLMTest } from "@/services/ai-v2/llm";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    const body = (await request.json()) as { userMessage?: string };
    const userMessage = body.userMessage?.trim() ?? "oi";
    const agent = await getV2Agent(id, r.session.user.organizationId!);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });

    const result = await callV2LLMTest(id, agent.simpleConfig, userMessage);
    return NextResponse.json({
      userMessage,
      output: result.output,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    console.error("[POST /api/ai-agents-v2/[id]/test]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao testar agente v2." },
      { status: 500 },
    );
  }
}
