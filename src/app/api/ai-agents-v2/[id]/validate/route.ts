import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { validateV2AgentConfig } from "@/services/ai-v2/config-validators";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/validate");

/** Validadores determinísticos do rascunho contra a organização (sem IA). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      await ensureV2AgentSchema();
      const findings = await validateV2AgentConfig(r.session.user.organizationId!, id);
      return NextResponse.json({ findings, blocking: findings.filter((f) => f.severity === "bloqueia").length });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/validate]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao validar a configuração." }, { status: 500 });
    }
  });
}
