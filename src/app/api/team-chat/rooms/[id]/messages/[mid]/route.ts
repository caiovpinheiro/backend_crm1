import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { deleteMessage } from "@/services/team-chat";
import { denyUnless, jsonError, viewerOf } from "../../../../_guard";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:send");
    if (denied) return denied;
    const { id, mid } = await params;
    const result = await deleteMessage(viewerOf(session), id, mid);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json({ ok: true });
  });
}
