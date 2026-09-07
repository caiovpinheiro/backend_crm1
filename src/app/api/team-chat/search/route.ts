import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { unifiedTeamChatSearch } from "@/services/team-chat";
import { denyUnless, viewerOf } from "../_guard";

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const result = await unifiedTeamChatSearch(viewerOf(session), q);
    return NextResponse.json(result);
  });
}
