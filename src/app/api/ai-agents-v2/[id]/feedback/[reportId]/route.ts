import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { cancelFeedbackReport, getFeedbackReport } from "@/services/ai-v2/feedback";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; reportId: string }> }) {
  const { id, reportId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    const data = await getFeedbackReport(r.session.user.organizationId!, id, reportId);
    if (!data) return NextResponse.json({ message: "Relatório não encontrado." }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/[id]/feedback/[reportId]]", err);
    return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao carregar o relatório." }, { status: 500 });
  }
}

/** Interrompe a geração em andamento. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; reportId: string }> }) {
  const { id, reportId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  const ok = await cancelFeedbackReport(r.session.user.organizationId!, id, reportId).catch(() => false);
  return NextResponse.json({ ok });
}
