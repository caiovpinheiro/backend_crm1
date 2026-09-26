import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { diagnoseV2Turn } from "@/services/ai-v2/diagnose";

/** "Onde o agente errou" num turno de teste → diagnóstico do que corrigir. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; logId: string }> },
) {
  const { id, logId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = (await request.json().catch(() => ({}))) as { comment?: unknown };
      const comment = typeof body.comment === "string" ? body.comment : "";
      if (!comment.trim()) {
        return NextResponse.json({ message: "Descreva onde o agente errou." }, { status: 400 });
      }
      const feedback = await diagnoseV2Turn({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        logId,
        comment: comment.slice(0, 2000),
        userId: r.session.user.id ?? null,
      });
      return NextResponse.json({ feedback });
    } catch (err) {
      console.error("[POST /api/ai-agents-v2/[id]/test-logs/[logId]/feedback]", err);
      const message = err instanceof Error ? err.message : "Erro ao diagnosticar.";
      const status = message === "Turno não encontrado." ? 404 : 500;
      return NextResponse.json({ message }, { status });
    }
  });
}
