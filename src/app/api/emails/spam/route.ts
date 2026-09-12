import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { listAccessibleAccountIds, resolveEmailAccess } from "@/services/email-accounts";
import { markEmailsAsSpam } from "@/services/emails";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  try {
    const access = await resolveEmailAccess(r.session.user);
    if (!access.canViewShared && !access.canViewOwn) {
      return NextResponse.json({ message: "Acesso negado.", required: "email_account:view" }, { status: 403 });
    }

    let body: { ids?: unknown; undo?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ message: "Selecione pelo menos um e-mail." }, { status: 400 });
    }

    const accountIds = await listAccessibleAccountIds(access);
    const result = await markEmailsAsSpam(ids, accountIds, body.undo === true);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro ao atualizar spam.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
