import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { updateMemberPrefs } from "@/services/team-chat";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";

const Body = z.object({
  muted: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const { id } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await updateMemberPrefs(viewerOf(session), id, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.room);
  });
}
