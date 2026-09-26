import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { cancelLearnRun, getLearnRun, markLearnDocAdded } from "@/services/ai-v2/learn";

type Params = { params: Promise<{ id: string; runId: string }> };

/** Busca com os materiais escritos e as conversas analisadas. */
export async function GET(_request: Request, { params }: Params) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const run = await getLearnRun(r.session.user.organizationId!, id, runId);
      if (!run) return NextResponse.json({ message: "Busca não encontrada." }, { status: 404 });
      return NextResponse.json({ run });
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/learn/[runId]]", err);
      return NextResponse.json({ message: "Erro ao carregar a busca." }, { status: 500 });
    }
  });
}

/** Marca um material como adicionado à base: `{ docId, knowledgeDocId }`. */
export async function PATCH(request: Request, { params }: Params) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const docId = typeof body.docId === "string" ? body.docId : "";
      const knowledgeDocId = typeof body.knowledgeDocId === "string" ? body.knowledgeDocId : "";
      if (!docId || !knowledgeDocId) return NextResponse.json({ message: "docId e knowledgeDocId são obrigatórios." }, { status: 400 });
      const ok = await markLearnDocAdded({ organizationId: r.session.user.organizationId!, agentId: id, runId, docId, knowledgeDocId });
      return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ message: "Material não encontrado." }, { status: 404 });
    } catch (err) {
      console.error("[PATCH /api/ai-agents-v2/[id]/learn/[runId]]", err);
      return NextResponse.json({ message: "Erro ao salvar." }, { status: 500 });
    }
  });
}

/** Cancela a busca em andamento. */
export async function DELETE(_request: Request, { params }: Params) {
  const { id, runId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const ok = await cancelLearnRun(r.session.user.organizationId!, id, runId);
      return NextResponse.json({ ok });
    } catch (err) {
      console.error("[DELETE /api/ai-agents-v2/[id]/learn/[runId]]", err);
      return NextResponse.json({ message: "Erro ao cancelar." }, { status: 500 });
    }
  });
}
