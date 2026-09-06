import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { destinationAccessWarning } from "@/services/team-chat-records";
import { denyUnless, jsonError, viewerOf } from "../../_guard";

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:view");
    if (denied) return denied;
    const url = new URL(request.url);
    const type = url.searchParams.get("type") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const roomIds = (url.searchParams.get("roomIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (type !== "deal" && type !== "conversation" && type !== "contact") {
      return jsonError("Tipo inválido.", 400);
    }
    if (!id) return jsonError("Informe o registro.", 400);
    const result = await destinationAccessWarning(viewerOf(session), roomIds, { type, id });
    return NextResponse.json(result);
  });
}
