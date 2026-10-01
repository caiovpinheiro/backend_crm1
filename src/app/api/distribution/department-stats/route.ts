/**
 * GET /api/distribution/department-stats
 * Contadores por departamento: distribuídos (histórico) e pendentes (fila).
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getDistributionDepartmentStats } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/distribution/department-stats");

export async function GET() {
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
            message:
              "Módulo de Distribuição não habilitado para esta organização.",
            code: "SMART_DISTRIBUTION_NOT_ENABLED",
          },
          { status: 403 },
        );
      }
      throw e;
    }

    try {
      const result = await getDistributionDepartmentStats();
      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "[GET /api/distribution/department-stats] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar estatísticas por departamento." },
        { status: 500 },
      );
    }
  });
}
