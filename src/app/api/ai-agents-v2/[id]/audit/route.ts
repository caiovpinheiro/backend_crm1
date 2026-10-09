import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getEngineAudit } from "@/services/ai-v2/audit";
import { parseActionReportFilters } from "@/services/ai-v2/actions-report";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/audit");

/** Auditoria do motor no período: defeitos objetivos por conversa e índice. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const url = new URL(request.url);
      const { from, to } = parseActionReportFilters(url.searchParams);
      const data = await getEngineAudit({ organizationId: r.session.user.organizationId!, agentId: id, from, to });
      return NextResponse.json(data);
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/audit]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao carregar a auditoria." }, { status: 500 });
    }
  });
}
