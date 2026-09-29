import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { setFeedbackItemStatus } from "@/services/ai-v2/feedback";

const STATUSES = ["open", "resolved", "ignored"] as const;

/** Marca um item como resolvido, ignorado ou aberto de novo. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {    const body = ((await request.json().catch(() => ({}))) ?? {}) as { status?: string };
    const status = STATUSES.find((s) => s === body.status);
    if (!status) return NextResponse.json({ message: "Status inválido." }, { status: 400 });
    const ok = await setFeedbackItemStatus({ organizationId: r.session.user.organizationId!, agentId: id, itemId, status, userId: r.session.user.id });
    if (!ok) return NextResponse.json({ message: "Item não encontrado." }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
