import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { estimateQualityRun } from "@/services/ai-v2/reply-quality";

const log = getLogger("api/ai-agents-v2/[id]/audit/quality/estimate");

/** Quantos turnos e conversas o período tem e quanto a análise deve custar. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const url = new URL(request.url);
      const input = Object.fromEntries(url.searchParams.entries());
      const data = await estimateQualityRun(r.session.user.organizationId!, id, input);
      return NextResponse.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao estimar a análise.";
      const status = msg.includes("não encontrado") ? 404 : 500;
      if (status === 500) log.error({ err }, "[GET /api/ai-agents-v2/[id]/audit/quality/estimate]");
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
