import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getCallsStats } from "@/services/calls";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/calls/stats");

/**
 * GET /api/calls/stats
 * Estatísticas agregadas para o mini-dash da aba de Chamadas.
 * RBAC: call:view
 *
 * Query params (mesmos filtros de escopo de /api/calls, sem direction/status):
 *   extensionId, contactId, search, dateFrom, dateTo
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "call:view");
    if (denied) return denied;

    const url = new URL(request.url);
    const filters = {
      extensionId: url.searchParams.get("extensionId") ?? undefined,
      contactId: url.searchParams.get("contactId") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      dateFrom: url.searchParams.get("dateFrom") ?? undefined,
      dateTo: url.searchParams.get("dateTo") ?? undefined,
    };

    try {
      const stats = await getCallsStats(filters);
      return NextResponse.json(stats);
    } catch (e) {
      log.error({ err: e }, "[calls] GET /stats");
      return NextResponse.json(
        { message: "Erro ao calcular estatísticas de chamadas." },
        { status: 500 },
      );
    }
  });
}
