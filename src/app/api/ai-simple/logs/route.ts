/**
 * GET /api/ai-simple/logs?conversationId=...&agentId=...
 *
 * Retorna os logs de turno da v2 simples. Exige `conversationId` ou
 * `agentId`. Usado pelas telas de depuração por conversa e por agente.
 */

import { NextResponse } from "next/server";
import { requireAuth, requirePermission, withOrgContext } from "@/lib/auth-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { listSimpleTurnLogs } from "@/services/ai-simple/log";

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const denied = await requirePermission(auth.session.user, "ai_agent:view");
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId")?.trim() ?? undefined;
  const agentId = searchParams.get("agentId")?.trim() ?? undefined;
  const take = Math.min(
    Math.max(Number(searchParams.get("take") ?? "50"), 1),
    200,
  );

  return withOrgContext(async () => {
    if (!conversationId && !agentId) {
      return NextResponse.json(
        { message: "Informe conversationId ou agentId." },
        { status: 400 },
      );
    }

    const organizationId = getOrgIdOrThrow();
    const logs = await listSimpleTurnLogs(
      organizationId,
      { conversationId, agentId },
      take,
    );
    return NextResponse.json({ logs });
  });
}
