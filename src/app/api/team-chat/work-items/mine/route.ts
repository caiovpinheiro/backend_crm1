import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { listMyWorkItems } from "@/services/team-chat-work-items";
import { denyUnless, viewerOf } from "../../_guard";

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const result = await listMyWorkItems(viewerOf(session));
    return NextResponse.json(result);
  });
}
