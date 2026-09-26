import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import {
  estimateFeedback,
  listFeedbackReports,
  startFeedbackReport,
  type FeedbackParams,
} from "@/services/ai-v2/feedback";
import type { FeedbackSourceType } from "@/services/ai-v2/feedback-extract";

const SOURCES: FeedbackSourceType[] = ["turn", "test_turn", "replay_point"];

function parseParams(body: Record<string, unknown>): FeedbackParams {
  const days = Number(body.days);
  const sources = Array.isArray(body.sources) ? body.sources.filter((s): s is FeedbackSourceType => SOURCES.includes(s as FeedbackSourceType)) : SOURCES;
  return {
    days: days === 7 || days === 90 ? days : 30,
    sources: sources.length > 0 ? sources : SOURCES,
  };
}

/** Relatórios de feedback já gerados para o agente. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {    try {
      const reports = await listFeedbackReports(r.session.user.organizationId!, id);
      return NextResponse.json({ reports });
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/feedback]", err);
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao listar relatórios." }, { status: 500 });
    }
  });
}

/** Gera um relatório (em segundo plano). Com `estimate: true` só estima. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const p = parseParams(body);
      const organizationId = r.session.user.organizationId!;
      if (body.estimate === true) {
        return NextResponse.json(await estimateFeedback({ organizationId, agentId: id, params: p }));
      }
      const res = await startFeedbackReport({ organizationId, agentId: id, userId: r.session.user.id, params: p });
      return NextResponse.json(res, { status: 202 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao gerar o relatório.";
      if (msg === "NO_OPENAI_KEY") {
        return NextResponse.json({ code: "NO_OPENAI_KEY", message: "Configure uma chave válida do modelo para gerar o relatório." }, { status: 400 });
      }
      console.error("[POST /api/ai-agents-v2/[id]/feedback]", err);
      return NextResponse.json({ message: msg }, { status: msg.startsWith("Já existe") ? 409 : 500 });
    }
  });
}
