import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  deleteKeepNote,
  getKeepNote,
  KeepError,
  serializeKeepNote,
  updateKeepNote,
} from "@/services/keeps/keeps";

export const dynamic = "force-dynamic";

function keepFail(err: unknown) {
  if (err instanceof KeepError) {
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
  throw err;
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:view");
  if (denied) return denied;
  if (!r.session.user.organizationId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }
  const { id } = await ctx.params;
  try {
    const note = await getKeepNote({ userId: r.session.user.id, id });
    return NextResponse.json({ note: serializeKeepNote(note, r.session.user.organizationId) });
  } catch (err) {
    return keepFail(err);
  }
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
    const note = await updateKeepNote({
      orgId: r.session.user.organizationId,
      userId: r.session.user.id,
      id,
      title: typeof body.title === "string" ? body.title : undefined,
      content: body.content,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
      archived: typeof body.archived === "boolean" ? body.archived : undefined,
      trashed: typeof body.trashed === "boolean" ? body.trashed : undefined,
    });
    return NextResponse.json({ note: serializeKeepNote(note, r.session.user.organizationId) });
  } catch (err) {
    return keepFail(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:delete");
  if (denied) return denied;
  const { id } = await ctx.params;
  const forever = new URL(request.url).searchParams.get("forever") === "1";
  try {
    const note = await deleteKeepNote({
      userId: r.session.user.id,
      id,
      forever,
    });
    if (!note) return NextResponse.json({ ok: true });
    return NextResponse.json({
      note: serializeKeepNote(note, r.session.user.organizationId!),
    });
  } catch (err) {
    return keepFail(err);
  }
}
