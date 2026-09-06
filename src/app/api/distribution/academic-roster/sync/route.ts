/**
 * POST /api/distribution/academic-roster/sync
 *
 * Força sync do roster acadêmico (depts + membros + AgentPermission +
 * DistributionResponsible). Idempotente. Útil após deploy / migração.
 *
 * Gate: smart_distribution + distribution:execute.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getVerticalPack } from "@/verticals";
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
            message:
              "Módulo de Distribuição não habilitado para esta organização.",
            code: "SMART_DISTRIBUTION_NOT_ENABLED",
          },
          { status: 403 },
        );
      }
      throw e;
    }

    const result = await getVerticalPack("academic")!.ops.ensureAcademicDepartmentRoster({ force: true });
    return NextResponse.json({
      ok: true,
      synced: result?.synced ?? 0,
      missing: result?.missing ?? [],
    });
  });
}
