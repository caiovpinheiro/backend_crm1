import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import { sendEmail } from "@/services/emails";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  if (!access.canViewShared && !access.canViewOwn) {
    return NextResponse.json({ message: "Acesso negado.", required: "email_account:view" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  if (!accountId || !to || !subject.trim()) {
    return NextResponse.json({ message: "accountId, to e subject são obrigatórios." }, { status: 400 });
  }

  const account = await getAccessibleAccount(accountId, access);
  if (!account) {
    return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  }

  try {
    const sent = await sendEmail({
      accountId,
      to,
      subject,
      bodyText: typeof body.bodyText === "string" ? body.bodyText : undefined,
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined,
    });
    return NextResponse.json(sent, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao enviar e-mail." },
      { status: 400 },
    );
  }
}
