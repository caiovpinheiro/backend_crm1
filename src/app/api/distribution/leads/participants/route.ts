/**
 * GET /api/distribution/leads/participants
 * Lista os participantes da Distribuição por Leads (configuração própria:
 * status administrativo ACTIVE/INACTIVE + peso 0–5 + slots do rodízio +
 * total recebido). Gateado pelo widget `smart_distribution` e
 * `distribution:view`.
 *
 * A config aqui NUNCA toca a elegibilidade do modo smart
 * (`DistributionResponsible`) — são tabelas independentes.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getLeadsParticipants } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

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
      const participants = await getLeadsParticipants();
      return NextResponse.json({ participants });
    } catch (e) {
      console.error("[GET /api/distribution/leads/participants]", e);
      return NextResponse.json(
        { message: "Erro ao carregar participantes." },
        { status: 500 },
      );
    }
  });
}
