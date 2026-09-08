import type { EmailFolder } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { listAccessibleAccountIds, resolveEmailAccess } from "@/services/email-accounts";
import { moveEmail } from "@/services/emails";

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

  let body: { systemFolder?: EmailFolder; customFolderId?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const ok = await moveEmail(id, accountIds, body);
  if (!ok) return NextResponse.json({ message: "E-mail não encontrado." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
