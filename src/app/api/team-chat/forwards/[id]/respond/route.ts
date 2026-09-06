import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { respondForward } from "@/services/team-chat-forwards";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";

const Body = z.object({
  responseNote: z.string().max(500).optional().default(""),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:forward");
    if (denied) return denied;
    const { id } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await respondForward(viewerOf(session), id, parsed.data.responseNote);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.forward);
  });
}
