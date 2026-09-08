/**
 * GET/PUT /api/distribution/settings
 * Configurações org-scoped da Distribuição Inteligente.
 *
 * Expõe:
 *   - `respectDepartment`:
 *       - false (default): distribuição CLÁSSICA org-wide (todos os elegíveis),
 *         ignorando departamento — nada fica preso na fila por falta de roteamento.
 *       - true: quando a conversa tem um departamento com distribuição automática
 *         ligada, restringe aos membros desse departamento; sem departamento cai
 *         no org-wide.
 *   - `enabled`:
 *       - true (default): motor atribui e drena a fila.
 *       - false: kill switch — inbound, automação, IA e drenagem não atribuem.
 *   - `autoOnInbound`:
 *       - true (default): todo ticket OPEN sem responsável entra na fila de
 *         espera (legado acadêmico — não exige passo na automação).
 *       - false: a fila só recebe quem passou por `execute_distribution`
 *         (automação, IA ou redistribuição manual).
 *
 * PUT aceita atualização PARCIAL (só grava as chaves presentes no corpo).
 * Gateado por `smart_distribution` + `distribution:execute`.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getOrgSettingBool, setOrgSettingBool } from "@/lib/org-settings";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

const RESPECT_DEPT_KEY = "distribution.respectDepartment";
const AUTO_ON_INBOUND_KEY = "distribution.autoOnInbound";
const ENABLED_KEY = "distribution.enabled";

async function guard(session: {
  user: { id: string; organizationId: string | null; isSuperAdmin: boolean };
}): Promise<NextResponse | null> {
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
  return null;
}

async function readSettings() {
  const [respectDepartment, autoOnInbound, enabled] = await Promise.all([
    getOrgSettingBool(RESPECT_DEPT_KEY, false),
    getOrgSettingBool(AUTO_ON_INBOUND_KEY, true),
    getOrgSettingBool(ENABLED_KEY, true),
  ]);
  return { respectDepartment, autoOnInbound, enabled };
}

export async function GET() {
  return withOrgContext(async (session) => {
    const denied = await guard(session);
    if (denied) return denied;
    return NextResponse.json(await readSettings());
  });
}

export async function PUT(req: Request) {
  return withOrgContext(async (session) => {
    const denied = await guard(session);
    if (denied) return denied;
    const body = (await req.json().catch(() => ({}))) as {
      respectDepartment?: unknown;
      autoOnInbound?: unknown;
      enabled?: unknown;
    };

    // Atualização PARCIAL: só toca as chaves presentes no corpo.
    if ("respectDepartment" in body) {
      await setOrgSettingBool(RESPECT_DEPT_KEY, Boolean(body.respectDepartment));
    }
    if ("autoOnInbound" in body) {
      await setOrgSettingBool(AUTO_ON_INBOUND_KEY, Boolean(body.autoOnInbound));
    }
    if ("enabled" in body) {
      await setOrgSettingBool(ENABLED_KEY, Boolean(body.enabled));
    }

    return NextResponse.json(await readSettings());
  });
}
