/**
 * POST /api/distribution/pending/retry
 * Re-tenta distribuir manualmente toda a fila de espera (mesma drenagem que
 * roda quando alguém fica ONLINE). Gateado por `smart_distribution` +
 * `distribution:execute`.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { enqueueProcessPendingOrRun } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

export async function POST() {
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
      const result = await enqueueProcessPendingOrRun({ trigger: "manual" });
      return NextResponse.json(result);
    } catch (e) {
      console.error("[POST /api/distribution/pending/retry]", e);
      return NextResponse.json(
        { message: "Erro ao reprocessar a fila de espera." },
        { status: 500 },
      );
    }
  });
}
