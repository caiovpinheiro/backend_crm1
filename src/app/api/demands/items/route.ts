import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { denyUnless, jsonError } from "../_guard";
import { ITEM_KINDS, PRIORITIES, createItem } from "@/services/demands";

const CreateItem = z.object({
  boardId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  stageId: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  assigneeIds: z.array(z.string().min(1)).max(50).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:create");
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const parsed = CreateItem.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await createItem(session.user.id, parsed.data);
    if ("error" in result) return jsonError(result.error, result.status);
    return NextResponse.json(result.item, { status: 201 });
  });
}
