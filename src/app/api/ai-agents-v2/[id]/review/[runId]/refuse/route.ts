import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { setSuggestionRefused } from "@/services/ai-v2/config-review";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/review/[runId]/refuse");

/** Recusa (ou desfaz a recusa de) uma sugestão: a próxima revisão não a repete. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const suggestionId = typeof body.suggestionId === "string" ? body.suggestionId : "";
      if (!suggestionId) return NextResponse.json({ message: "Informe a sugestão." }, { status: 400 });
      await setSuggestionRefused({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        runId,
        suggestionId,
        refused: body.refused !== false,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao recusar.";
      const status = msg.includes("não encontrad") ? 404 : 500;
      if (status === 500) log.error({ err }, "[POST /api/ai-agents-v2/[id]/review/[runId]/refuse]");
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
