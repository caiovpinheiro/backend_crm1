import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  connectEmailAccount,
  isEmailFieldError,
  listEmailAccounts,
  parseConnectInput,
  resolveEmailAccess,
} from "@/services/email-accounts";
import { syncEmailAccount } from "@/services/email-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  if (!access.canViewShared && !access.canViewOwn) {
    const denied = await requirePermission(r.session.user, "email_account:view");
    if (denied) return denied;
  }
  const accounts = await listEmailAccounts(access);
  return NextResponse.json({ accounts });
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "email_account:connect");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, field: "email", message: "JSON inválido." }, { status: 400 });
  }

  const parsed = parseConnectInput(body);
  if (isEmailFieldError(parsed)) {
    return NextResponse.json(parsed, { status: 400 });
  }

  const result = await connectEmailAccount(parsed, r.session.user.id);
  if (!result.ok) return NextResponse.json(result, { status: 400 });

  try {
    await syncEmailAccount(result.account.id);
  } catch {
    /* sync inicial não bloqueia a conexão */
  }

  return NextResponse.json(result, { status: 201 });
}
