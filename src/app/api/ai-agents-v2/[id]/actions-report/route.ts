import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getActionsReport, parseActionReportFilters } from "@/services/ai-v2/actions-report";

/** Ações do agente no período, filtradas e paginadas. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get("page") ?? "1");
      const data = await getActionsReport({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        filters: parseActionReportFilters(url.searchParams),
        page: Number.isFinite(page) ? page : 1,
      });
      return NextResponse.json(data);
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/actions-report]", err);
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao carregar o relatório." }, { status: 500 });
    }
  });
}
