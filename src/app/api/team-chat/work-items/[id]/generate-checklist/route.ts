import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { generateChecklistFromMeeting } from "@/services/team-chat-work-items";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:work_item");
    if (denied) return denied;
    const { id } = await params;
    const result = await generateChecklistFromMeeting(viewerOf(session), id);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.workItem, { status: 201 });
  });
}
