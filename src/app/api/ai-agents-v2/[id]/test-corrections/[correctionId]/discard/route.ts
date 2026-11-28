import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { dropTestCorrection } from "@/services/ai-v2/corrections";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/test-corrections/[correctionId]/discard");

/** Descarta a correção: ela deixa de valer nos testes. O rascunho fica como está. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; correctionId: string }> },
) {
  const { id, correctionId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const ok = await dropTestCorrection({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        id: correctionId,
        userId: r.session.user.id ?? null,
        to: "discarded",
      });
      if (!ok) return NextResponse.json({ message: "Correção não encontrada ou já descartada." }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      log.error({ err }, "[POST /api/ai-agents-v2/[id]/test-corrections/[correctionId]/discard]");
      return NextResponse.json(
        { message: err instanceof Error ? err.message : "Erro ao descartar a correção." },
        { status: 500 },
      );
    }
  });
}
