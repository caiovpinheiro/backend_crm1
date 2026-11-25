import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { applyTestCorrection } from "@/services/ai-v2/corrections";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/test-corrections/[correctionId]/apply");

/** Aplica a mudança sugerida no rascunho do agente. A versão publicada não muda. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; correctionId: string }> },
) {
  const { id, correctionId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = (await request.json().catch(() => ({}))) as { tipo?: unknown; titulo?: unknown; texto?: unknown };
      const result = await applyTestCorrection({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        id: correctionId,
        userId: r.session.user.id ?? null,
        override: { tipo: body.tipo, titulo: body.titulo, texto: body.texto },
      });
      return NextResponse.json(result);
    } catch (err) {
      log.error({ err }, "[POST /api/ai-agents-v2/[id]/test-corrections/[correctionId]/apply]");
      const message = err instanceof Error ? err.message : "Erro ao aplicar a correção.";
      const status = message === "Correção não encontrada." ? 404 : /já foi decidida|Sem sugestão|ficaria inválido/.test(message) ? 400 : 500;
      return NextResponse.json({ message }, { status });
    }
  });
}
