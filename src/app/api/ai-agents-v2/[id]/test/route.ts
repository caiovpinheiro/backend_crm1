import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { simulateV2Turn } from "@/services/ai-v2/test-turn";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json()) as {
      userMessage?: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
      contactId?: string;
      stage?: "idle" | "confirming" | "identifying" | "active" | "closed";
    };
    const userMessage = body.userMessage?.trim() ?? "oi";
    const history = Array.isArray(body.history) ? body.history : [];
    const contactId = body.contactId?.trim();
    const stage = body.stage ?? "active";
    const agent = await getV2Agent(id, r.session.user.organizationId!);
    if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });

    const configToTest = agent.draftConfig ?? agent.publishedConfig;
    const result = await simulateV2Turn(
      id,
      configToTest,
      userMessage,
      history,
      r.session.user.organizationId!,
      contactId,
      undefined,
      stage,
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/ai-agents-v2/[id]/test]", err);
    const raw = err instanceof Error ? err.message : String(err);
    if (raw === "NO_OPENAI_KEY" || raw.includes("chave OpenAI") || raw.includes("NO_KEY_MSG")) {
      return NextResponse.json(
        { ok: false, code: "NO_OPENAI_KEY", message: "Configure uma chave válida do modelo para testar o agente." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao testar agente v2." },
      { status: 500 },
    );
  }
}
