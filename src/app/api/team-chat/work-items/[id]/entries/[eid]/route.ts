import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { updateWorkItemEntry } from "@/services/team-chat-work-items";
import { denyUnless, jsonError, viewerOf } from "../../../../_guard";

const Patch = z.object({
  text: z.string().min(1).max(500).optional(),
  assigneeId: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  status: z.enum(["open", "done"]).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; eid: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:work_item");
    if (denied) return denied;
    const { id, eid } = await params;
    const parsed = Patch.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await updateWorkItemEntry(viewerOf(session), id, eid, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.workItem);
  });
}
