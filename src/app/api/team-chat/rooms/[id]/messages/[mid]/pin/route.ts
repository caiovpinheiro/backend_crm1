import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { togglePin } from "@/services/team-chat";
import { denyUnless, isServiceError, jsonError, viewerOf } from "../../../../../_guard";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:send");
    if (denied) return denied;
    const { id, mid } = await params;
    const result = await togglePin(viewerOf(session), id, mid);
    if (isServiceError(result)) return jsonError(result.error, result.status);
    return NextResponse.json(result.message);
  });
}
