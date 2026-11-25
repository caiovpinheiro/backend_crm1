import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { draftCorrectionSuggestion } from "@/services/ai-v2/corrections";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/test-corrections/[correctionId]/suggest");

/** Gera de novo a mudança sugerida para o rascunho (quando faltou ou não serviu). */
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
      const correction = await draftCorrectionSuggestion({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        id: correctionId,
      });
      if (!correction) return NextResponse.json({ message: "Correção não encontrada." }, { status: 404 });
      return NextResponse.json({ correction });
    } catch (err) {
      log.error({ err }, "[POST /api/ai-agents-v2/[id]/test-corrections/[correctionId]/suggest]");
      return NextResponse.json(
        { message: err instanceof Error ? err.message : "Erro ao gerar a sugestão." },
        { status: 500 },
      );
    }
  });
}
