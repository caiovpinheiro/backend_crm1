/**
 * PUT /api/distribution/leads/participants/[userId]
 * Upsert da configuração do participante no modo leads: `status`
 * (ACTIVE|INACTIVE), `weight` (0–5) e/ou `note` (observação, até 500
 * caracteres; string vazia limpa). Na primeira configuração cria os 5
 * slots persistentes. Status/peso controlam SOMENTE recebimentos futuros —
 * leads já atribuídos permanecem com o responsável.
 *
 * Exige `distribution:manage` + widget `smart_distribution`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { upsertLeadsParticipant } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

type RouteContext = { params: Promise<{ userId: string }> };

const bodySchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    weight: z.number().int().min(0).max(5).optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "Nenhum campo para atualizar.",
  });

export async function PUT(request: Request, context: RouteContext) {
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

    const { userId } = await context.params;

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const participant = await upsertLeadsParticipant({
        userId,
        status: parsed.data.status,
        weight: parsed.data.weight,
        note: parsed.data.note,
      });
      if (!participant) {
        return NextResponse.json(
          { message: "Usuário não encontrado nesta organização." },
          { status: 404 },
        );
      }
      return NextResponse.json({ participant });
    } catch (e) {
      console.error("[PUT /api/distribution/leads/participants/[userId]]", e);
      return NextResponse.json(
        { message: "Erro ao salvar participante." },
        { status: 500 },
      );
    }
  });
}
