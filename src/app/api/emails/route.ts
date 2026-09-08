import type { EmailFolder } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { listAccessibleAccountIds, resolveEmailAccess } from "@/services/email-accounts";
import { listEmails } from "@/services/emails";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  if (!access.canViewShared && !access.canViewOwn) {
    return NextResponse.json({ message: "Acesso negado.", required: "email_account:view" }, { status: 403 });
  }

  const accountIds = await listAccessibleAccountIds(access);
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder") as EmailFolder | null;
  const result = await listEmails({
    accountIds,
    accountId: url.searchParams.get("accountId") ?? undefined,
    folder: folder ?? undefined,
    customFolderId: url.searchParams.get("customFolderId") ?? undefined,
    search: url.searchParams.get("q") ?? undefined,
    page: Number(url.searchParams.get("page") ?? 1) || 1,
    perPage: Number(url.searchParams.get("perPage") ?? 25) || 25,
  });
  return NextResponse.json(result);
}
