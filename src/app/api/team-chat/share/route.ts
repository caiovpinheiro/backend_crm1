import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { shareRecordToChat } from "@/services/team-chat";
import { denyUnless, jsonError, viewerOf } from "../_guard";

const Body = z.object({
  type: z.enum(["deal", "conversation", "contact"]),
  id: z.string().min(1),
  roomIds: z.array(z.string().min(1)).max(20).optional().default([]),
  personIds: z.array(z.string().min(1)).max(20).optional().default([]),
  content: z.string().max(4000).optional().default(""),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:send");
    if (denied) return denied;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await shareRecordToChat(viewerOf(session), parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result, { status: 201 });
  });
}
