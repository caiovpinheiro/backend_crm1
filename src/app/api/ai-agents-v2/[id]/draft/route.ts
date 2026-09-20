import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { saveV2AgentDraft } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json()) as { config?: unknown };
    const agent = await saveV2AgentDraft(id, r.session.user.organizationId!, body);
    return NextResponse.json(agent);
  } catch (err) {
    console.error("[PUT /api/ai-agents-v2/[id]/draft]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao salvar rascunho." },
      { status: 500 },
    );
  }
}
