import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { applyListenProposal } from "@/services/ai-v2/listen";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/listen/proposals/[proposalId]/apply");

function fail(err: unknown, where: string) {
  const msg = err instanceof Error ? err.message : "Erro na escuta da equipe.";
  if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
  const status = /não encontrad/.test(msg) ? 404 : /Já existe|Já está lendo|já foi decidida|atualizada por uma leitura/.test(msg) ? 409 : /Escolha|no máximo|não é da equipe|futuro|desligada|terminou|Informe/.test(msg) ? 400 : 500;
  if (status === 500) log.error({ where, err }, "escuta da equipe falhou");
  return NextResponse.json({ message: msg }, { status });
}

/** Aplica a proposta no rascunho (conhecimento: registra o material criado). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const { id, proposalId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      return NextResponse.json(await applyListenProposal({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        proposalId,
        userId: r.session.user.id,
        knowledgeDocId: typeof body.knowledgeDocId === "string" ? body.knowledgeDocId : null,
      }));
    } catch (err) {
      return fail(err, "POST /api/ai-agents-v2/[id]/listen/proposals/[proposalId]/apply");
    }
  });
}
