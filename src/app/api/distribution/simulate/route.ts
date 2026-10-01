/**
 * POST /api/distribution/simulate  ("Testar distribuição")
 * Faz a MESMA avaliação/seleção do motor, mas NÃO atribui e NÃO grava log.
 * Retorna o diagnóstico completo + a escolha prevista. Exige
 * `distribution:execute` e o widget `smart_distribution`.
 *
 * Body: { distributionType? }
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { simulateDistribution } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/distribution/simulate");

const bodySchema = z.object({
  distributionType: z.string().trim().max(100).nullable().optional(),
});

export async function POST(request: Request) {
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

    let json: unknown = {};
    try {
      json = await request.json();
    } catch {
      // corpo vazio é aceitável
    }
    const parsed = bodySchema.safeParse(json ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    try {
      const result = await simulateDistribution({
        distributionType: parsed.data.distributionType ?? null,
      });
      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "[POST /api/distribution/simulate] falhou");
      return NextResponse.json(
        { message: "Erro ao simular distribuição." },
        { status: 500 },
      );
    }
  });
}
