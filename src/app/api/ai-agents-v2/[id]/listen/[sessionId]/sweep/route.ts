import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { sweepListenNow } from "@/services/ai-v2/listen";

function fail(err: unknown, where: string) {
  const msg = err instanceof Error ? err.message : "Erro na escuta da equipe.";
  if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
  const status = /não encontrad/.test(msg) ? 404 : /Já existe|Já está lendo|já foi decidida|atualizada por uma leitura/.test(msg) ? 409 : /Escolha|no máximo|não é da equipe|futuro|desligada|terminou|Informe/.test(msg) ? 400 : 500;
  if (status === 500) console.error(`[${where}]`, err);
  return NextResponse.json({ message: msg }, { status });
}

/** "Ler agora": lê as conversas prontas sem esperar a próxima varredura. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      return NextResponse.json(await sweepListenNow(r.session.user.organizationId!, id, sessionId), { status: 202 });
    } catch (err) {
      return fail(err, "POST /api/ai-agents-v2/[id]/listen/[sessionId]/sweep");
    }
  });
}
