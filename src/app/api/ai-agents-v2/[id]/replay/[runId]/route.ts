import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { cancelReplay, getReplayRun } from "@/services/ai-v2/replay";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/** Uma comparação: andamento, placar e cada ponto lado a lado. */
export async function GET(_request: Request, { params }: Ctx) {
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

/** Interrompe a comparação; os pontos já comparados ficam. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    const ok = await cancelReplay(r.session.user.organizationId!, id, runId);
    if (!ok) return NextResponse.json({ message: "Esta comparação não está em andamento." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/ai-agents-v2/[id]/replay/[runId]]", err);
    return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao interromper." }, { status: 500 });
  }
}
