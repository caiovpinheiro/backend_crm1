import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { estimateListen } from "@/services/ai-v2/listen";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/listen/estimate");

function fail(err: unknown, where: string) {
  const msg = err instanceof Error ? err.message : "Erro na escuta da equipe.";
  if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
  const status = /não encontrad/.test(msg) ? 404 : /Já existe|Já está lendo|já foi decidida|atualizada por uma leitura/.test(msg) ? 409 : /Escolha|origem|no máximo|não é da equipe|futuro|desligada|terminou|Informe/.test(msg) ? 400 : 500;
  if (status === 500) log.error({ where, err }, "escuta da equipe falhou");
  return NextResponse.json({ message: msg }, { status });
}

/** Quanto a escuta deve custar por dia para estas pessoas (pelos últimos 7 dias). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const userIds = Array.isArray(body.userIds) ? body.userIds.filter((x): x is string => typeof x === "string") : [];
      const originStageIds = Array.isArray(body.originStageIds) ? body.originStageIds.filter((x): x is string => typeof x === "string") : [];
      return NextResponse.json(await estimateListen(r.session.user.organizationId!, id, userIds, originStageIds));
    } catch (err) {
      return fail(err, "POST /api/ai-agents-v2/[id]/listen/estimate");
    }
  });
}
