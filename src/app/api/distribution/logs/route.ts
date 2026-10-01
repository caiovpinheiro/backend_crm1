/**
 * GET /api/distribution/logs?cursor&limit
 * Histórico de distribuições (quem recebeu, quando, resultado). Gateado por
 * `smart_distribution` + `distribution:execute`.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getDistributionLogs } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/distribution/logs");

export async function GET(req: Request) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "distribution:execute")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "distribution:execute" },
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
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 30;
      const result = await getDistributionLogs({ cursor, limit });
      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "[GET /api/distribution/logs] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar o histórico de distribuições." },
        { status: 500 },
      );
    }
  });
}
