import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { extractEntriesFromText } from "@/services/team-chat-work-items";
import { denyUnless, jsonError } from "../../_guard";

const Body = z.object({ text: z.string().min(1).max(8000) });

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:work_item");
    if (denied) return denied;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Texto inválido.", 400);
    return NextResponse.json(extractEntriesFromText(parsed.data.text));
  });
}
