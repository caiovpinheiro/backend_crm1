import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { createEmailRule, isRuleAction, isRuleField, listEmailRules } from "@/services/email-rules";

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
    if (!accountId || !name) {
      return NextResponse.json({ message: "accountId e name são obrigatórios." }, { status: 400 });
    }
    if (!isRuleField(conditionField)) {
      return NextResponse.json({ message: "conditionField inválido." }, { status: 400 });
    }
    if (!isRuleAction(action)) {
      return NextResponse.json({ message: "action inválida." }, { status: 400 });
    }
    if (conditionField !== "ALWAYS" && !conditionValue.trim()) {
      return NextResponse.json({ message: "conditionValue é obrigatório." }, { status: 400 });
    }
    if (action === "MOVE" && typeof body.targetFolderId !== "string") {
      return NextResponse.json({ message: "Selecione a pasta de destino." }, { status: 400 });
    }
    if (action === "FORWARD" && (typeof body.actionTarget !== "string" || !body.actionTarget.includes("@"))) {
      return NextResponse.json({ message: "Informe o e-mail para encaminhar." }, { status: 400 });
    }
    if (action === "REPLY" && (typeof body.actionBody !== "string" || !body.actionBody.trim())) {
      return NextResponse.json({ message: "Escreva o texto da resposta automática." }, { status: 400 });
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
      actionTarget: typeof body.actionTarget === "string" ? body.actionTarget : null,
      actionBody: typeof body.actionBody === "string" ? body.actionBody : null,
      priority: typeof body.priority === "number" ? body.priority : 0,
      organizationId,
    });
    return NextResponse.json({ rule }, { status: 201 });
  });
}
