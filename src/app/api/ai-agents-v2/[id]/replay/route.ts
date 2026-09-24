import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { estimateReplay, listReplayRuns, REPLAY_LIMITS, startReplay, type ReplayParams } from "@/services/ai-v2/replay";

function parseParams(body: Record<string, unknown>): ReplayParams {
  const days = Number(body.days ?? 1);
  const conversations = Number(body.conversations ?? 30);
  return {
    days: Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 30) : 1,
    conversations: Number.isFinite(conversations)
      ? Math.min(Math.max(Math.round(conversations), 1), REPLAY_LIMITS.maxConversations)
      : 30,
    config: body.config === "published" ? "published" : "draft",
  };
}

/** Comparações já feitas deste agente. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    const runs = await listReplayRuns(r.session.user.organizationId!, id);
    return NextResponse.json({ runs, limits: REPLAY_LIMITS });
  } catch (err) {
    console.error("[GET /api/ai-agents-v2/[id]/replay]", err);
    return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao listar comparações." }, { status: 500 });
  }
}

/**
 * Inicia uma comparação com atendimentos humanos (roda em segundo plano).
 * Com `estimate: true` só devolve quantas conversas há e o custo estimado.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const p = parseParams(body);
    const organizationId = r.session.user.organizationId!;
    if (body.estimate === true) {
      return NextResponse.json(await estimateReplay({ organizationId, agentId: id, params: p }));
    }
    const result = await startReplay({ organizationId, agentId: id, userId: r.session.user.id, params: p });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "NO_OPENAI_KEY") {
      return NextResponse.json({ code: "NO_OPENAI_KEY", message: "Configure uma chave válida do modelo para comparar." }, { status: 400 });
    }
    const status = msg.includes("em andamento") ? 409 : msg.includes("não encontrado") ? 404 : 500;
    if (status === 500) console.error("[POST /api/ai-agents-v2/[id]/replay]", err);
    return NextResponse.json({ message: msg }, { status });
  }
}
