import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { FORWARD_TYPES, forwardWithAnnotation } from "@/services/team-chat-forwards";
import { denyUnless, jsonError, viewerOf } from "../_guard";

const Body = z.object({
  sourceRoomId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  excerpt: z.string().trim().min(1).max(2000),
  note: z.string().trim().min(1).max(2000),
  type: z.enum(FORWARD_TYPES),
  destRoomId: z.string().min(1).optional(),
  destPersonId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:forward");
    if (denied) return denied;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await forwardWithAnnotation(viewerOf(session), parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result, { status: 201 });
  });
}
