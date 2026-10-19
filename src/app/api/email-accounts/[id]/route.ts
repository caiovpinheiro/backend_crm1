import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  disconnectEmailAccount,
  getAccessibleAccount,
  resolveEmailAccess,
  updateEmailAccountConnection,
} from "@/services/email-accounts";

export const dynamic = "force-dynamic";

/**
 * Edita servidores IMAP/SMTP, senha, visibilidade e opções da conta. Mesmo
 * formato de corpo e de erro do POST /api/email-accounts; campo ausente mantém
 * o atual, `password` vazia mantém a senha. Testa a conexão antes de gravar.
 */
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
  if (!account) {
    return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, field: "form", message: "JSON inválido." }, { status: 400 });
  }

  const result = await updateEmailAccountConnection(account, body, r.session.user.id);
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
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
  const access = await resolveEmailAccess(r.session.user);
  const account = await getAccessibleAccount(id, access);
  if (!account) {
    return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  }

  await disconnectEmailAccount(id);
  return NextResponse.json({ ok: true });
}
