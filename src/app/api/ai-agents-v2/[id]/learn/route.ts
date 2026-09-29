import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { listLearnRuns, listLearnTabulations, startLearnRun } from "@/services/ai-v2/learn";
import type { LearnParams } from "@/services/ai-v2/learn-extract";

function parseParams(body: Record<string, unknown>): LearnParams | null {
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 200) : "";
  if (topic.length < 3) return null;
  const days = Number(body.days);
  return {
    topic,
    days: days === 30 || days === 180 ? days : 90,
    tabulationIds: Array.isArray(body.tabulationIds) ? body.tabulationIds.filter((t): t is string => typeof t === "string").slice(0, 50) : [],
    who: body.who === "human" || body.who === "agent" ? body.who : "both",
    onlyResolved: body.onlyResolved !== false,
  };
}

/** Buscas já feitas para o agente e as tabulações da organização (filtro). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const organizationId = r.session.user.organizationId!;
      const [runs, tabulations] = await Promise.all([
        listLearnRuns(organizationId, id),
        listLearnTabulations(organizationId).catch(() => []),
      ]);
      return NextResponse.json({ runs, tabulations });
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/learn]", err);
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao listar as buscas." }, { status: 500 });
    }
  });
}

/** Busca conversas que deram certo sobre o assunto e escreve materiais (em segundo plano). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const p = parseParams(body);
      if (!p) return NextResponse.json({ message: "Descreva o assunto (ao menos 3 letras)." }, { status: 400 });
      const res = await startLearnRun({ organizationId: r.session.user.organizationId!, agentId: id, userId: r.session.user.id, params: p });
      return NextResponse.json(res, { status: 202 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao iniciar a busca.";
      if (msg === "NO_OPENAI_KEY") {
        return NextResponse.json({ code: "NO_OPENAI_KEY", message: "Configure a chave da OpenAI do agente para buscar nas conversas." }, { status: 400 });
      }
      console.error("[POST /api/ai-agents-v2/[id]/learn]", err);
      return NextResponse.json({ message: msg }, { status: msg.startsWith("Já existe") ? 409 : 500 });
    }
  });
}
