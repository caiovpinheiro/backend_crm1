import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { listAccessibleAccountIds, resolveEmailAccess } from "@/services/email-accounts";
import { markEmailRead } from "@/services/emails";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  const accountIds = await listAccessibleAccountIds(access);
  const { id } = await params;
  let isRead = true;
  try {
    const body = (await request.json()) as { isRead?: boolean };
    if (typeof body.isRead === "boolean") isRead = body.isRead;
  } catch {
    /* default true */
  }
  const ok = await markEmailRead(id, accountIds, isRead);
  if (!ok) return NextResponse.json({ message: "E-mail não encontrado." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
