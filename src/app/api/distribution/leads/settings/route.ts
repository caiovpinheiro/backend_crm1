/**
 * GET/PUT /api/distribution/leads/settings
 * Kill switch do modo leads (`distribution.leads.enabled`, default true).
 * Independente do kill switch do smart (`distribution.enabled`) — os dois
 * motores coexistem e cada um tem o seu toggle.
 *
 * GET: `distribution:view` · PUT: `distribution:execute` (paridade com o
 * toggle operacional do smart). Ambos gateados pelo widget.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getOrgSettingBool, setOrgSettingBool } from "@/lib/org-settings";
import { LEADS_DISTRIBUTION_ENABLED_KEY } from "@/services/distribution/leads/enabled";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

async function readSettings() {
  const enabled = await getOrgSettingBool(LEADS_DISTRIBUTION_ENABLED_KEY, true);
  return { enabled: enabled !== false };
}

function widgetGuardError(e: unknown): NextResponse | null {
  if (e instanceof WidgetNotEnabledError) {
    return NextResponse.json(
      {
        message: "Módulo de Distribuição não habilitado para esta organização.",
        code: "SMART_DISTRIBUTION_NOT_ENABLED",
      },
      { status: 403 },
    );
  }
  return null;
}

export async function GET() {
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
      const denied = widgetGuardError(e);
      if (denied) return denied;
      throw e;
    }
    return NextResponse.json(await readSettings());
  });
}

export async function PUT(req: Request) {
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
      const denied = widgetGuardError(e);
      if (denied) return denied;
      throw e;
    }

    const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { message: "Informe enabled (boolean)." },
        { status: 400 },
      );
    }
    await setOrgSettingBool(LEADS_DISTRIBUTION_ENABLED_KEY, body.enabled);
    return NextResponse.json(await readSettings());
  });
}
