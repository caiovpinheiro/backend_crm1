import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { deleteEmailRule, isRuleAction, isRuleField, updateEmailRule } from "@/services/email-rules";

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
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const rule = await updateEmailRule(id, {
    name: typeof body.name === "string" ? body.name : undefined,
    isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
    conditionField: isRuleField(body.conditionField) ? body.conditionField : undefined,
    conditionValue: typeof body.conditionValue === "string" ? body.conditionValue : undefined,
    action: isRuleAction(body.action) ? body.action : undefined,
    targetFolderId: body.targetFolderId === null || typeof body.targetFolderId === "string"
      ? (body.targetFolderId as string | null)
      : undefined,
    actionTarget: body.actionTarget === null || typeof body.actionTarget === "string"
      ? (body.actionTarget as string | null)
      : undefined,
    actionBody: body.actionBody === null || typeof body.actionBody === "string"
      ? (body.actionBody as string | null)
      : undefined,
    priority: typeof body.priority === "number" ? body.priority : undefined,
  });
  if (!rule) return NextResponse.json({ message: "Regra não encontrada." }, { status: 404 });
  return NextResponse.json({ rule });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "email_account:connect");
  if (denied) return denied;
  const { id } = await params;
  const ok = await deleteEmailRule(id);
  if (!ok) return NextResponse.json({ message: "Regra não encontrada." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
