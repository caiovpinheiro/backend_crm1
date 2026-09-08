import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { createEmailCustomFolder, listEmailCustomFolders } from "@/services/email-folders";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  if (!access.canViewShared && !access.canViewOwn) {
    return NextResponse.json({ message: "Acesso negado.", required: "email_account:view" }, { status: 403 });
  }
  const accountId = new URL(request.url).searchParams.get("accountId") ?? undefined;
  if (accountId) {
    const account = await getAccessibleAccount(accountId, access);
    if (!account) return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  }
  const folders = await listEmailCustomFolders(accountId);
  return NextResponse.json({ folders });
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "email_account:connect");
  if (denied) return denied;
  const access = await resolveEmailAccess(r.session.user);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!accountId || !name) {
    return NextResponse.json({ message: "accountId e name são obrigatórios." }, { status: 400 });
  }
  const account = await getAccessibleAccount(accountId, access);
  if (!account) return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });

  const folder = await createEmailCustomFolder({
    accountId,
    name,
    color: typeof body.color === "string" ? body.color : null,
  });
  return NextResponse.json({ folder }, { status: 201 });
}
