import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { refuseListenProposal } from "@/services/ai-v2/listen";

function fail(err: unknown, where: string) {
  const msg = err instanceof Error ? err.message : "Erro na escuta da equipe.";
  if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
  const status = /não encontrad/.test(msg) ? 404 : /Já existe|Já está lendo|já foi decidida|atualizada por uma leitura/.test(msg) ? 409 : /Escolha|no máximo|não é da equipe|futuro|desligada|terminou|Informe/.test(msg) ? 400 : 500;
  if (status === 500) console.error(`[${where}]`, err);
  return NextResponse.json({ message: msg }, { status });
}

/** Recusa (ou desfaz a recusa): não volta a ser proposta. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const { id, proposalId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      await refuseListenProposal({ organizationId: r.session.user.organizationId!, agentId: id, proposalId, userId: r.session.user.id, refused: body.refused !== false });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return fail(err, "POST /api/ai-agents-v2/[id]/listen/proposals/[proposalId]/refuse");
    }
  });
}
