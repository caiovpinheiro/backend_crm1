import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getConfigReview } from "@/services/ai-v2/config-review";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/review/[runId]");

/** Uma revisão: resumo e sugestões. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const run = await getConfigReview(r.session.user.organizationId!, id, runId);
      if (!run) return NextResponse.json({ message: "Revisão não encontrada." }, { status: 404 });
      return NextResponse.json({ run });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/review/[runId]]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao carregar a revisão." }, { status: 500 });
    }
  });
}
