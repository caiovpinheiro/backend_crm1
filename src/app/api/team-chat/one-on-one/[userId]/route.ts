import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getOneOnOne } from "@/services/team-chat-forwards";
import { denyUnless, viewerOf } from "../../_guard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const { userId } = await params;
    const result = await getOneOnOne(viewerOf(session), userId);
    return NextResponse.json(result);
  });
}
