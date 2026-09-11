/**
 * GET /api/distribution/leads/participants
 * Lista os operadores (HUMAN + MEMBER) da org + config do modo leads
 * (ACTIVE/INACTIVE + peso 0–5 + slots + total recebido). Admin/gestor
 * não entram. Quem ainda não foi configurado aparece INACTIVE/peso 0
 * e não recebe. Gateado pelo widget `smart_distribution` e
 * `distribution:view`.
 *
 * A config aqui NUNCA toca a elegibilidade do modo smart
 * (`DistributionResponsible`) — são tabelas independentes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import {
  getLeadsParticipants,
  upsertLeadsParticipantsBulk,
} from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

const bulkSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  weight: z.number().int().min(0).max(5).optional(),
});

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

/**
 * POST /api/distribution/leads/participants
 * Inclui vários operadores no rodízio (status/peso iguais para o lote).
 * Admin/gestor são ignorados. Exige `distribution:manage`.
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    if (!can(ctx, "distribution:manage")) {
      return NextResponse.json(
        { message: "Acesso negado.", required: "distribution:manage" },
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

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const parsed = bulkSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const result = await upsertLeadsParticipantsBulk({
        userIds: parsed.data.userIds,
        status: parsed.data.status ?? "ACTIVE",
        weight: parsed.data.weight ?? 1,
      });
      const participants = await getLeadsParticipants();
      return NextResponse.json({ ...result, participants });
    } catch (e) {
      console.error("[POST /api/distribution/leads/participants]", e);
      return NextResponse.json(
        { message: "Erro ao adicionar participantes." },
        { status: 500 },
      );
    }
  });
}
