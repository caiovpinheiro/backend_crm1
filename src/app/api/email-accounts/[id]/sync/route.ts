import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { syncEmailAccount } from "@/services/email-sync";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "email_account:connect");
  if (denied) return denied;

  const { id } = await params;
  const access = await resolveEmailAccess(r.session.user);
  const account = await getAccessibleAccount(id, access);
  if (!account) {
    return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  }

  const result = await syncEmailAccount(id);
  return NextResponse.json(result);
}
