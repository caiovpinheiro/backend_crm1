import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { listTestCorrectionsView } from "@/services/ai-v2/corrections";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/test-corrections");

/** Correções de quem testa (`#corrigir`): as que valem nos testes e as já decididas. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const corrections = await listTestCorrectionsView(r.session.user.organizationId!, id);
      return NextResponse.json({ corrections });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/test-corrections]");
      return NextResponse.json(
        { message: err instanceof Error ? err.message : "Erro ao listar correções." },
        { status: 500 },
      );
    }
  });
}
