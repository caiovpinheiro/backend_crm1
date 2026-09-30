import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { updateListen } from "@/services/ai-v2/listen";
import type { ListenMode } from "@/services/ai-v2/listen-extract";

function fail(err: unknown, where: string) {
  const msg = err instanceof Error ? err.message : "Erro na escuta da equipe.";
  if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
  const status = /não encontrad/.test(msg) ? 404 : /Já existe|Já está lendo|já foi decidida|atualizada por uma leitura/.test(msg) ? 409 : /Escolha|no máximo|não é da equipe|futuro|desligada|terminou|Informe/.test(msg) ? 400 : 500;
  if (status === 500) console.error(`[${where}]`, err);
  return NextResponse.json({ message: msg }, { status });
}

const ACTIONS = ["pause", "resume", "off", "extend"] as const;

/** Pausar, retomar, desligar ou estender a escuta. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const action = ACTIONS.find((a) => a === body.action);
      if (!action) return NextResponse.json({ message: "Ação inválida." }, { status: 400 });
      await updateListen({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        sessionId,
        userId: r.session.user.id,
        action,
        mode: typeof body.mode === "string" ? (body.mode as ListenMode) : undefined,
        days: typeof body.days === "number" ? body.days : undefined,
        endsAt: typeof body.endsAt === "string" ? body.endsAt : null,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return fail(err, "PATCH /api/ai-agents-v2/[id]/listen/[sessionId]");
    }
  });
}
