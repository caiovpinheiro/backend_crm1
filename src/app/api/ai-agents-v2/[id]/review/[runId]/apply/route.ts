import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { applyReviewSuggestions } from "@/services/ai-v2/config-review";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/review/[runId]/apply");

/** Aplica no rascunho as sugestões escolhidas (a versão publicada não muda). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const ids = Array.isArray(body.suggestionIds) ? body.suggestionIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
      if (ids.length === 0) return NextResponse.json({ message: "Escolha ao menos uma sugestão." }, { status: 400 });
      return NextResponse.json(await applyReviewSuggestions({ organizationId: r.session.user.organizationId!, agentId: id, runId, suggestionIds: ids }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao aplicar.";
      const status = msg.includes("não encontrad") ? 404 : 500;
      if (status === 500) log.error({ err }, "[POST /api/ai-agents-v2/[id]/review/[runId]/apply]");
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
