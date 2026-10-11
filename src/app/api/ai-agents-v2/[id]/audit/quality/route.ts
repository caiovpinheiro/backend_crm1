import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { listQualityRuns, startQualityRun } from "@/services/ai-v2/reply-quality";

const log = getLogger("api/ai-agents-v2/[id]/audit/quality");

type Params = { params: Promise<{ id: string }> };

/** Análises de qualidade da resposta já feitas para o agente (a mais nova primeiro). */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const runs = await listQualityRuns(r.session.user.organizationId!, id);
      return NextResponse.json({ runs });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/[id]/audit/quality]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao listar as análises." }, { status: 500 });
    }
  });
}

/** Inicia a análise do período (roda em segundo plano). */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const result = await startQualityRun({ organizationId: r.session.user.organizationId!, agentId: id, userId: r.session.user.id, input: body });
      return NextResponse.json(result, { status: 202 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao iniciar a análise.";
      if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
      const status = msg.includes("andamento") ? 409 : msg.includes("não encontrado") ? 404 : msg.includes("pelo menos") ? 400 : 500;
      if (status === 500) log.error({ err }, "[POST /api/ai-agents-v2/[id]/audit/quality]");
      return NextResponse.json({ message: msg }, { status });
    }
  });
}
