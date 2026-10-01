import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { syncApi4ComCalls } from "@/services/call-sync-api4com";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/calls/sync");

/**
 * POST /api/calls/sync
 * Reconcilia o histórico de chamadas puxando o CDR da Api4com (GET /calls)
 * e fazendo upsert em `Call`. Usado pela página /calls (ao abrir e após
 * discar) pra garantir o registro mesmo quando o webhook não está
 * configurado/alcançável. Best-effort: não dispara automações.
 * RBAC: call:view
 */
export async function POST(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "call:view");
    if (denied) return denied;

    try {
      const result = await syncApi4ComCalls(authResult.user.id);
      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "[calls] sync");
      return NextResponse.json(
        { ok: false, message: "Erro ao sincronizar chamadas." },
        { status: 500 },
      );
    }
  });
}
