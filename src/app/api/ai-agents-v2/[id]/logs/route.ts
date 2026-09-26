import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { listV2TurnLogs } from "@/services/ai-v2/log";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const url = new URL(request.url);
      const conversationId = url.searchParams.get("conversationId") ?? undefined;
      const take = Number(url.searchParams.get("take") ?? "50");
      const skip = Number(url.searchParams.get("skip") ?? "0");
      const logs = await listV2TurnLogs({
        organizationId: r.session.user.organizationId!,
        agentId: id,
        conversationId,
        take,
        skip,
      });
      return NextResponse.json({ logs });
    } catch (err) {
      console.error("[GET /api/ai-agents-v2/[id]/logs]", err);
      return NextResponse.json(
        { message: err instanceof Error ? err.message : "Erro ao listar logs v2." },
        { status: 500 },
      );
    }
  });
}
