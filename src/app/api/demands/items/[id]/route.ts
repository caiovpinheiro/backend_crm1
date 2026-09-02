import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { denyUnless, jsonError } from "../../_guard";
import { ITEM_KINDS, PRIORITIES, deleteItem, getItem, updateItem } from "@/services/demands";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:view");
    if (denied) return denied;
    const { id } = await ctx.params;
    const item = await getItem(id, session.user.id);
    if (!item) return jsonError("Demanda não encontrada.", 404);
    return NextResponse.json(item);
  });
}

const PatchItem = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(8000).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  dueAt: z.string().nullable().optional(),
});

export async function PATCH(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:edit");
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const parsed = PatchItem.safeParse(body);
    if (!parsed.success) return jsonError("Dados inválidos.", 400);
    const item = await updateItem(session.user.id, id, parsed.data);
    if (!item) return jsonError("Demanda não encontrada.", 404);
    return NextResponse.json(item);
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "demand:edit");
    if (denied) return denied;
    const { id } = await ctx.params;
    const ok = await deleteItem(id);
    if (!ok) return jsonError("Demanda não encontrada.", 404);
    return NextResponse.json({ ok: true });
  });
}
