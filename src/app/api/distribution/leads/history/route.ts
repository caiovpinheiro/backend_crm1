/**
 * GET /api/distribution/leads/history?from&to&userId&cursor&limit
 * Histórico do rodízio leads: data/hora, lead (contato) e consultor, com
 * filtros por período e consultor e paginação por cursor. Sem fila de espera
 * — o modo leads não tem pending. `distribution:view` + widget.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getLeadsHistory, parseLeadsDateParam } from "@/services/distribution";
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
      const limitRaw = Number(url.searchParams.get("limit"));
      const result = await getLeadsHistory({
        from: parseLeadsDateParam(url.searchParams.get("from"), "start"),
        to: parseLeadsDateParam(url.searchParams.get("to"), "end"),
        userId: url.searchParams.get("userId") ?? undefined,
        cursor: url.searchParams.get("cursor"),
        limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
      });
      return NextResponse.json(result);
    } catch (e) {
      console.error("[GET /api/distribution/leads/history]", e);
      return NextResponse.json(
        { message: "Erro ao carregar histórico." },
        { status: 500 },
      );
    }
  });
}
