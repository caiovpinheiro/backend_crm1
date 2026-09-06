import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { addWorkItemEntry } from "@/services/team-chat-work-items";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";

const Body = z.object({
  text: z.string().min(1).max(500),
  assigneeId: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:work_item");
    if (denied) return denied;
    const { id } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await addWorkItemEntry(viewerOf(session), id, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.workItem, { status: 201 });
  });
}
