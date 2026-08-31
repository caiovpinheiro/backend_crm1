/**
 * GET /api/distribution/pending?limit&cursor
 * Lista os leads na fila de espera da Distribuição (não distribuídos por
 * falta de responsável elegível). Página limitada (default 50, máx. 100)
 * + `total` da fila. Gateado por `smart_distribution` + `distribution:view`.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getPendingDistributions } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

export async function GET(req: Request) {
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
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor");
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
      const result = await getPendingDistributions({ cursor, limit });
      return NextResponse.json(result);
    } catch (e) {
      console.error("[GET /api/distribution/pending]", e);
      return NextResponse.json(
        { message: "Erro ao carregar a fila de espera." },
        { status: 500 },
      );
    }
  });
}
