import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { syncEmailAccount } from "@/services/email-sync";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

    const { id } = await params;
    const access = await resolveEmailAccess(session.user);
    const account = await getAccessibleAccount(id, access);
    if (!account) {
      return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
    }

    const result = await syncEmailAccount(id, organizationId);
    return NextResponse.json(result);
  });
}
