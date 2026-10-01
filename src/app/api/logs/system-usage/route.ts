import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { getSystemActivityAggregate } from "@/services/system-activity";

import { parsePeriod } from "./_period";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/logs/system-usage");

export const dynamic = "force-dynamic";

/**
 * GET /api/logs/system-usage?from=ISO&to=ISO
 *
 * Resumo por usuário do USO REAL do CRM dentro da janela.
 * Restrito a ADMIN/MANAGER; escopado por organização.
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }
    const orgId = getOrgIdOrNull();
    if (!orgId) {
      return NextResponse.json({ items: [] });
    }

    const { searchParams } = new URL(request.url);
    const period = parsePeriod(searchParams);
    if (!period.ok) {
      return NextResponse.json({ message: period.message }, { status: 400 });
    }

    try {
      const items = await getSystemActivityAggregate({
        organizationId: orgId,
        from: period.from,
        to: period.to,
      });
      return NextResponse.json({ items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("system_activity_sessions")) {
        return NextResponse.json({ items: [], pending: true });
      }
      log.error({ err }, "[logs/system-usage] erro");
      return NextResponse.json(
        { message: "Erro ao carregar uso do sistema." },
        { status: 500 },
      );
    }
  });
}
