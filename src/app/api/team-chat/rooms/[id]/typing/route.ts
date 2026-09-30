import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { signalTyping } from "@/services/team-chat";
import { denyUnless, isServiceError, jsonError, viewerOf } from "../../../_guard";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const { id } = await params;
    const name = (session.user as { name?: string | null }).name?.trim() || "Colega";
    const result = await signalTyping(viewerOf(session), id, name);
    if (isServiceError(result)) return jsonError(result.error, result.status);
    return NextResponse.json({ ok: true });
  });
}
