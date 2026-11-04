/**
 * GET/PUT /api/distribution/leads/settings
 * Kill switch do modo leads (`distribution.leads.enabled`, default DESLIGADO)
 * e o controle das regras de horário por departamento
 * (`distribution.leads.departmentRules.enabled`, default DESLIGADO — ligado,
 * o sorteio fica restrito aos departamentos com regra ativa).
 * Independente do kill switch do smart (`distribution.enabled`) — os dois
 * motores coexistem e cada um tem o seu toggle. Ligar é decisão explícita da org.
 *
 * GET: `distribution:view` · PUT: `distribution:execute` (paridade com o
 * toggle operacional do smart). Ambos gateados pelo widget.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { can, loadAuthzContext } from "@/lib/authz";
import { getOrgSettingBool, setOrgSettingBool } from "@/lib/org-settings";
import { LEADS_DEPARTMENT_RULES_ENABLED_KEY } from "@/services/distribution/leads/department-rules";
import { LEADS_DISTRIBUTION_ENABLED_KEY } from "@/services/distribution/leads/enabled";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

const log = getLogger("distribution.leads.settings");

async function readSettings() {
  const [enabled, departmentRulesEnabled] = await Promise.all([
    getOrgSettingBool(LEADS_DISTRIBUTION_ENABLED_KEY, false),
    getOrgSettingBool(LEADS_DEPARTMENT_RULES_ENABLED_KEY, false),
  ]);
  return {
    enabled: enabled === true,
    departmentRulesEnabled: departmentRulesEnabled === true,
  };
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

    const body = (await req.json().catch(() => ({}))) as {
      enabled?: unknown;
      departmentRulesEnabled?: unknown;
    };
    const hasEnabled = body.enabled !== undefined;
    const hasRules = body.departmentRulesEnabled !== undefined;
    if (!hasEnabled && !hasRules) {
      return NextResponse.json(
        { message: "Informe enabled e/ou departmentRulesEnabled (boolean)." },
        { status: 400 },
      );
    }
    if (hasEnabled && typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { message: "Informe enabled (boolean)." },
        { status: 400 },
      );
    }
    if (hasRules && typeof body.departmentRulesEnabled !== "boolean") {
      return NextResponse.json(
        { message: "Informe departmentRulesEnabled (boolean)." },
        { status: 400 },
      );
    }
    if (hasRules) {
      await setOrgSettingBool(
        LEADS_DEPARTMENT_RULES_ENABLED_KEY,
        body.departmentRulesEnabled as boolean,
      );
    }
    if (hasEnabled) {
      await setOrgSettingBool(LEADS_DISTRIBUTION_ENABLED_KEY, body.enabled as boolean);
    }
    if (body.enabled === true) {
      try {
        const { drainLeadsPending } = await import(
          "@/services/distribution/leads/pending"
        );
        await drainLeadsPending();
      } catch (e) {
        log.warn({ err: e }, "[leads] drenagem ao ligar o modo falhou");
      }
    }
    return NextResponse.json(await readSettings());
  });
}
