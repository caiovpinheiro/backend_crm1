import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { toggleReaction } from "@/services/team-chat";
import { denyUnless, isServiceError, jsonError, viewerOf } from "../../../../../_guard";

const Body = z.object({ emoji: z.string().min(1).max(8) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:send");
    if (denied) return denied;
    const { id, mid } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Reação inválida.", 400);
    const result = await toggleReaction(viewerOf(session), id, mid, parsed.data.emoji);
    if (isServiceError(result)) return jsonError(result.error, result.status);
    return NextResponse.json(result.message);
  });
}
