/**
 * GET /api/distribution/leads/stats?from&to&userId
 * Indicadores do modo leads: total de distribuições, quantidade por
 * consultor e ranking (desc). Fonte: `DistributionLeadsAssignment` — gravado
 * somente na transaction vencedora do claim, então retries nunca duplicam a
 * contagem. `distribution:view` + widget `smart_distribution`.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getLeadsStats, parseLeadsDateParam } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "distribution:view")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "distribution:view" },
        { status: 403 },
      );
    }

    try {
      await assertSmartDistributionEnabled();
    } catch (e) {
      if (e instanceof WidgetNotEnabledError) {
        return NextResponse.json(
          {
            message: "Módulo de Distribuição não habilitado para esta organização.",
            code: "SMART_DISTRIBUTION_NOT_ENABLED",
          },
          { status: 403 },
        );
      }
      throw e;
    }

    try {
      const url = new URL(request.url);
      const stats = await getLeadsStats({
        from: parseLeadsDateParam(url.searchParams.get("from"), "start"),
        to: parseLeadsDateParam(url.searchParams.get("to"), "end"),
        userId: url.searchParams.get("userId") ?? undefined,
      });
      return NextResponse.json(stats);
    } catch (e) {
      console.error("[GET /api/distribution/leads/stats]", e);
      return NextResponse.json(
        { message: "Erro ao carregar indicadores." },
        { status: 500 },
      );
    }
  });
}
