/**
 * POST /api/ai-simple/release
 *
 * Permite a um operador humano devolver uma conversa ao bot da v2 simples.
 * Define `humanActive = false` no estado da conversa.
 */

import { NextResponse } from "next/server";
import { requireAuth, requirePermission, withOrgContext } from "@/lib/auth-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { releaseSimpleConversationToBot } from "@/services/ai-simple/engine";

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const denied = await requirePermission(auth.session.user, "ai_agent:edit");
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  return withOrgContext(async () => {
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    if (!conversationId) {
      return NextResponse.json({ message: "conversationId é obrigatório." }, { status: 400 });
    }

    const organizationId = getOrgIdOrThrow();
    await releaseSimpleConversationToBot(organizationId, conversationId);
    return NextResponse.json({ ok: true });
  });
}
