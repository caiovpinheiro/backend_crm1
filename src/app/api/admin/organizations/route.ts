import { OrgStatus } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/auth-helpers";
import { listOrganizations } from "@/services/organizations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/admin/organizations");

export async function GET(request: Request) {
  const r = await requireSuperAdmin();
  if (!r.ok) return r.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam && Object.values(OrgStatus).includes(statusParam as OrgStatus)
      ? (statusParam as OrgStatus)
      : undefined;

  try {
    const organizations = await listOrganizations({ search, status });
    return NextResponse.json({ organizations });
  } catch (e) {
    log.error({ err: e }, "[admin/organizations GET] falhou");
    const msg = e instanceof Error ? e.message : "Erro ao listar organizações.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
