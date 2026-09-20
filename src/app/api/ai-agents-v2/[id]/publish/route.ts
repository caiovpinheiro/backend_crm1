import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { publishV2AgentVersion } from "@/services/ai-v2/agents";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    await ensureV2AgentSchema();
    const body = (await request.json()) as { comment?: string };
    const result = await publishV2AgentVersion(
      id,
      r.session.user.organizationId!,
      r.session.user.id,
      body.comment,
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/ai-agents-v2/[id]/publish]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao publicar agente." },
      { status: 500 },
    );
  }
}
