import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
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
  return withOrgContext(async (session) => {
    const access = await resolveEmailAccess(session.user);
    if (!access.canViewShared && !access.canViewOwn) {
      const denied = await requirePermission(session.user, "email_account:view");
      if (denied) return denied;
    }
    const accounts = await listEmailAccounts(access);
    return NextResponse.json({ accounts });
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "email_account:connect");
    if (denied) return denied;

    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json(
        { message: "Sessão sem organização — contate o suporte." },
        { status: 401 },
      );
    }

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

    const result = await connectEmailAccount(parsed, session.user.id, organizationId);
    if (!result.ok) return NextResponse.json(result, { status: 400 });

    try {
      await syncEmailAccount(result.account.id, organizationId);
    } catch {
      /* sync inicial não bloqueia a conexão */
    }

    return NextResponse.json(result, { status: 201 });
  });
}
