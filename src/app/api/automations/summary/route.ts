import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { getAutomationListSummary } from "@/services/automations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/summary");

/**
 * GET /api/automations/summary
 *
 * Totais da org para KPIs / popover da listagem — COUNTs + logs só de hoje.
 * Substitui o segundo GET `/api/automations?perPage=200` no first paint.
 */
export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    try {
      const summary = await getAutomationListSummary();
      return NextResponse.json(summary);
    } catch (e) {
      log.error({ err: e }, "[GET /api/automations/summary] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar resumo de automações." },
        { status: 500 },
      );
    }
  });
}
