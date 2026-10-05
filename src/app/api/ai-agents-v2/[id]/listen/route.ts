import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getListenState, startListen } from "@/services/ai-v2/listen";
import type { ListenMode } from "@/services/ai-v2/listen-extract";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/[id]/listen");

type Params = { params: Promise<{ id: string }> };

function fail(err: unknown, where: string) {
  const msg = err instanceof Error ? err.message : "Erro na escuta da equipe.";
  if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: msg, message: "Configure a chave do modelo do agente em Publicação." }, { status: 400 });
  const status = /não encontrad/.test(msg) ? 404 : /Já existe|Já está lendo|já foi decidida|atualizada por uma leitura/.test(msg) ? 409 : /Escolha|origem|no máximo|não é da equipe|futuro|desligada|terminou|Informe/.test(msg) ? 400 : 500;
  if (status === 500) log.error({ where, err }, "escuta da equipe falhou");
  return NextResponse.json({ message: msg }, { status });
}

/** Escuta atual do agente, leituras recentes e propostas. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      return NextResponse.json(await getListenState(r.session.user.organizationId!, id));
    } catch (err) {
      return fail(err, "GET /api/ai-agents-v2/[id]/listen");
    }
  });
}

const MODES: ListenMode[] = ["today", "days", "range", "continuous"];

/** Liga a escuta: pessoas da equipe e período. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const mode = MODES.includes(body.mode as ListenMode) ? (body.mode as ListenMode) : "today";
      const result = await startListen({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        userId: r.session.user.id,
        userIds: Array.isArray(body.userIds) ? body.userIds.filter((x): x is string => typeof x === "string") : [],
        originStageIds: Array.isArray(body.originStageIds) ? body.originStageIds.filter((x): x is string => typeof x === "string") : [],
        mode,
        days: typeof body.days === "number" ? body.days : undefined,
        endsAt: typeof body.endsAt === "string" ? body.endsAt : null,
        maxUsdPerDay: typeof body.maxUsdPerDay === "number" ? body.maxUsdPerDay : undefined,
        maxConversationsPerDay: typeof body.maxConversationsPerDay === "number" ? body.maxConversationsPerDay : undefined,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      return fail(err, "POST /api/ai-agents-v2/[id]/listen");
    }
  });
}
