/**
 * Guarda comum dos endpoints de regras por departamento do modo leads:
 * sessão da org + permissão de distribuição + widget `smart_distribution`.
 * `distribution:view` lê; `distribution:manage` grava (paridade com os
 * participantes do modo leads).
 */

import { NextResponse } from "next/server";

import { can, loadAuthzContext } from "@/lib/authz";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

type SessionUser = {
  id: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
};

export async function guardLeadsDepartmentRules(
  user: SessionUser,
  permission: "distribution:view" | "distribution:manage",
): Promise<NextResponse | null> {
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  });
  if (!can(ctx, permission)) {
    return NextResponse.json(
      { message: "Acesso negado.", required: permission },
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
  return null;
}
