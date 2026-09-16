import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  deleteKeepCategory,
  KeepError,
  serializeKeepCategory,
  updateKeepCategory,
} from "@/services/keeps/keeps";

export const dynamic = "force-dynamic";

function keepFail(err: unknown) {
  if (err instanceof KeepError) {
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
  throw err;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:edit");
  if (denied) return denied;
  if (!r.session.user.organizationId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  try {
    const cat = await updateKeepCategory({
      userId: r.session.user.id,
      id,
      name: typeof body.name === "string" ? body.name : undefined,
      position: typeof body.position === "number" ? body.position : undefined,
    });
    return NextResponse.json({ category: serializeKeepCategory(cat) });
  } catch (err) {
    return keepFail(err);
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:edit");
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    await deleteKeepCategory({ userId: r.session.user.id, id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return keepFail(err);
  }
}
