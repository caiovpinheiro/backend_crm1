import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { exportActionsReportCsv, parseActionReportFilters } from "@/services/ai-v2/actions-report";

/** Mesmos filtros do relatório, em CSV. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const url = new URL(request.url);
      const csv = await exportActionsReportCsv({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        filters: parseActionReportFilters(url.searchParams),
      });
      const stamp = new Date().toISOString().slice(0, 10);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="acoes-do-agente-${stamp}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/actions-report/export]", err);
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao exportar." }, { status: 500 });
    }
  });
}
