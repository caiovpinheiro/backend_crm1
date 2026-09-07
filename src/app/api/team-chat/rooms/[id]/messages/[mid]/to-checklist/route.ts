import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { createChecklistFromMessage } from "@/services/team-chat-work-items";
import { denyUnless, jsonError, viewerOf } from "../../../../../_guard";

const Body = z.object({
  title: z.string().trim().max(200).optional(),
  entries: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        assigneeId: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
      }),
    )
    .max(40)
    .optional(),
  anchor: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:work_item");
    if (denied) return denied;
    const { id, mid } = await params;
    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await createChecklistFromMessage(viewerOf(session), id, mid, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.workItem, { status: 201 });
  });
}
