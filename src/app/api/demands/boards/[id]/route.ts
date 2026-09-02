import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { denyUnless, jsonError } from "../../_guard";
import { addStage, deleteBoard, getBoard } from "@/services/demands";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:view");
    if (denied) return denied;
    const { id } = await ctx.params;
    const board = await getBoard(id);
    if (!board) return jsonError("Board não encontrado.", 404);
    return NextResponse.json(board);
  });
}

const AddStage = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().trim().max(20).optional(),
});

export async function POST(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:manage_board");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const parsed = AddStage.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const stage = await addStage(id, parsed.data);
    if (!stage) return jsonError("Board não encontrado.", 404);
    return NextResponse.json(stage, { status: 201 });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:manage_board");
    if (denied) return denied;
    const { id } = await ctx.params;
    const ok = await deleteBoard(id);
    if (!ok) return jsonError("Board não encontrado.", 404);
    return NextResponse.json({ ok: true });
  });
}
