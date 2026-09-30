import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { denyUnless, isServiceError, jsonError } from "../../../_guard";
import { moveItem } from "@/services/demands";

type Ctx = { params: Promise<{ id: string }> };

const Move = z.object({
  stageId: z.string().min(1),
  beforeId: z.string().nullable().optional(),
  afterId: z.string().nullable().optional(),
});

export async function POST(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:move");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const parsed = Move.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const result = await moveItem(session.user.id, id, parsed.data);
    if (isServiceError(result)) return jsonError(result.error, result.status);
    return NextResponse.json(result.item);
  });
}
