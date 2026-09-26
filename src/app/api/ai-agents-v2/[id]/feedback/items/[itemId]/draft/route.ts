import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import { draftFeedbackDocument } from "@/services/ai-v2/feedback";

/** Rascunho do material que falta, a partir das perguntas e respostas reais. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  try {
    return NextResponse.json(await draftFeedbackDocument({ organizationId: r.session.user.organizationId!, agentId: id, itemId }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao gerar o rascunho.";
    if (msg === "NO_OPENAI_KEY") return NextResponse.json({ code: "NO_OPENAI_KEY", message: "Configure uma chave válida do modelo." }, { status: 400 });
    return NextResponse.json({ message: msg }, { status: msg === "Item não encontrado." ? 404 : 500 });
  }
}
