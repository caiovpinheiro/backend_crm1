import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { createEmailRule, listEmailRules } from "@/services/email-rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const access = await resolveEmailAccess(session.user);
    if (!access.canViewShared && !access.canViewOwn) {
      return NextResponse.json({ message: "Acesso negado.", required: "email_account:view" }, { status: 403 });
    }
    const accountId = new URL(request.url).searchParams.get("accountId") ?? undefined;
    if (accountId) {
      const account = await getAccessibleAccount(accountId, access);
      if (!account) return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
    }
    const rules = await listEmailRules(accountId);
    return NextResponse.json({ rules });
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "email_account:connect");
    if (denied) return denied;

    const access = await resolveEmailAccess(session.user);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const conditionField = body.conditionField;
    const conditionValue = typeof body.conditionValue === "string" ? body.conditionValue : "";
    const action = body.action;
    if (!accountId || !name || !conditionValue) {
      return NextResponse.json({ message: "accountId, name e conditionValue são obrigatórios." }, { status: 400 });
    }
    if (conditionField !== "FROM" && conditionField !== "TO" && conditionField !== "SUBJECT") {
      return NextResponse.json({ message: "conditionField inválido." }, { status: 400 });
    }
    if (action !== "MOVE" && action !== "TRASH") {
      return NextResponse.json({ message: "action inválida." }, { status: 400 });
    }

    const account = await getAccessibleAccount(accountId, access);
    if (!account) return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });

    const organizationId = session.user.organizationId ?? account.organizationId;
    const rule = await createEmailRule({
      accountId,
      name,
      isActive: body.isActive !== false,
      conditionField,
      conditionValue,
      action,
      targetFolderId: typeof body.targetFolderId === "string" ? body.targetFolderId : null,
      priority: typeof body.priority === "number" ? body.priority : 0,
      organizationId,
    });
    return NextResponse.json({ rule }, { status: 201 });
  });
}
