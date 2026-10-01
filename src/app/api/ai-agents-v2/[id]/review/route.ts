import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { currentReviewConfigHash, listConfigReviews, startConfigReview } from "@/services/ai-v2/config-review";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/review");

type Params = { params: Promise<{ id: string }> };

/** Revisões da configuração já feitas para o agente. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const orgId = r.session.user.organizationId!;
      const [runs, currentConfigHash] = await Promise.all([listConfigReviews(orgId, id), currentReviewConfigHash(orgId, id)]);
      return NextResponse.json({ runs, currentConfigHash });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/review]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao listar as revisões." }, { status: 500 });
    }
  });
}

/** Inicia a revisão com o modelo escolhido (roda em segundo plano). */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const days = Number(body.days);
      const result = await startConfigReview({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        userId: r.session.user.id,
        params: {
          model: typeof body.model === "string" ? body.model : "",
          includeTurns: body.includeTurns !== false,
          days: days === 15 || days === 30 ? days : 7,
        },
      });
      return NextResponse.json(result, { status: 202 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao iniciar a revisão.";
      if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
      if (msg === "NO_ANTHROPIC_KEY") return NextResponse.json({ code: msg, message: "Para usar um modelo Claude, cadastre a chave Anthropic do agente em Publicação." }, { status: 400 });
      const status = msg.includes("andamento") ? 409 : msg.includes("não encontrado") ? 404 : msg.includes("modelo da lista") ? 400 : 500;
      if (status === 500) log.error({ err }, "[POST /api/ai-agents-v2/[id]/review]");
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
