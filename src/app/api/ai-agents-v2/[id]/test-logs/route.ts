import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { listV2TestConversations } from "@/services/ai-v2/test-logs";

/** Conversas dos números de teste do agente, com o rastro de cada turno. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  try {
    const days = Number(new URL(request.url).searchParams.get("days") ?? "7");
    const result = await listV2TestConversations({
      organizationId: r.session.user.organizationId!,
      agentId: id,
      days: Number.isFinite(days) && days > 0 ? Math.min(days, 30) : 7,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/[id]/test-logs]", err);
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Erro ao listar conversas de teste." },
      { status: 500 },
    );
  }
}
