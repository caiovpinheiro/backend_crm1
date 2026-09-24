import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { getReplayRun } from "@/services/ai-v2/replay";

/** Uma comparação: andamento, placar e cada ponto lado a lado. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    const result = await getReplayRun(r.session.user.organizationId!, id, runId);
    if (!result) return NextResponse.json({ message: "Comparação não encontrada." }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/[id]/replay/[runId]]", err);
    return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao carregar comparação." }, { status: 500 });
  }
}
