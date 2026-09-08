import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { deleteEmailCustomFolder, updateEmailCustomFolder } from "@/services/email-folders";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "email_account:connect");
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  const folder = await updateEmailCustomFolder(id, {
    name: typeof body.name === "string" ? body.name : undefined,
    color: body.color === null || typeof body.color === "string" ? (body.color as string | null) : undefined,
  });
  if (!folder) return NextResponse.json({ message: "Pasta não encontrada." }, { status: 404 });
  return NextResponse.json({ folder });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "email_account:connect");
  if (denied) return denied;
  const { id } = await params;
  const ok = await deleteEmailCustomFolder(id);
  if (!ok) return NextResponse.json({ message: "Pasta não encontrada." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
