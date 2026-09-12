import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { updateEmailAccountOoo } from "@/services/email-rules";

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
  const access = await resolveEmailAccess(r.session.user);
  const account = await getAccessibleAccount(id, access);
  if (!account) return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const ooo = await updateEmailAccountOoo(id, {
    oooEnabled: body.oooEnabled === true,
    oooMessage: typeof body.oooMessage === "string" ? body.oooMessage : null,
    oooStartsAt: typeof body.oooStartsAt === "string" ? body.oooStartsAt : null,
    oooEndsAt: typeof body.oooEndsAt === "string" ? body.oooEndsAt : null,
  });
  if (!ooo) return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  return NextResponse.json({ ooo });
}
