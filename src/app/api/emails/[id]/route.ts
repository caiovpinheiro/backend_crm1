import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { listAccessibleAccountIds, resolveEmailAccess } from "@/services/email-accounts";
import { deleteEmail, getEmail } from "@/services/emails";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  const accountIds = await listAccessibleAccountIds(access);
  const { id } = await params;
  const email = await getEmail(id, accountIds);
  if (!email) return NextResponse.json({ message: "E-mail não encontrado." }, { status: 404 });
  return NextResponse.json({ email });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  const accountIds = await listAccessibleAccountIds(access);
  const { id } = await params;
  const ok = await deleteEmail(id, accountIds);
  if (!ok) return NextResponse.json({ message: "E-mail não encontrado." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
