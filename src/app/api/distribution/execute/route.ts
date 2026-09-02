/**
 * POST /api/distribution/execute
 * Enfileira a distribuição REAL no `worker-distribution`. Trigger
 * manual. Exige `distribution:execute` (gestores) **ou**
 * `conversation:claim` (consultor redistribuindo do inbox) e o widget
 * `smart_distribution`.
 *
 * Espera o job (8–15s). Timeout → 202 `{ queued, jobId }` — o worker
 * termina e o SSE publica `conversation_updated`.
 *
 * Body: {
 *   dealId?, contactId?, conversationId?,
 *   distributionType?,
 *   departmentId?, departmentIds?,
 *   reassign?  // true = redistribui mesmo com responsável atual
 * }
 */

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { metrics } from "@/lib/metrics";
import { runDistributionExecuteOrInline } from "@/lib/distribution-execute-queue";
import { executeDistribution } from "@/services/distribution";
import {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

const bodySchema = z.object({
  dealId: z.string().min(1).optional(),
  contactId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  distributionType: z.string().trim().max(100).nullable().optional(),
  departmentId: z.string().min(1).optional(),
  departmentIds: z.array(z.string().min(1)).max(50).optional(),
  reassign: z.boolean().optional(),
});

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json(
        { message: "Organização obrigatória." },
        { status: 400 },
      );
    }

    const ctx = await loadAuthzContext({
      userId: session.user.id,
      organizationId,
      isSuperAdmin: session.user.isSuperAdmin,
    });
    const canExecute =
      can(ctx, "distribution:execute") || can(ctx, "conversation:claim");
    if (!canExecute) {
      return NextResponse.json(
        {
          message: "Acesso negado.",
          required: "distribution:execute|conversation:claim",
        },
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
      // corpo vazio é aceitável (seleção sem alvo)
    }
    const parsed = bodySchema.safeParse(json ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Dados inválidos.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const departmentIds = Array.from(
      new Set(
        [
          ...(parsed.data.departmentIds ?? []),
          ...(parsed.data.departmentId ? [parsed.data.departmentId] : []),
        ].filter(Boolean),
      ),
    );

    const departmentId = parsed.data.departmentId ?? null;
    const executeInput = {
      dealId: parsed.data.dealId,
      contactId: parsed.data.contactId,
      conversationId: parsed.data.conversationId,
      distributionType: parsed.data.distributionType ?? null,
      departmentIds: departmentIds.length > 0 ? departmentIds : null,
      reassign: parsed.data.reassign === true,
      triggerSource: "MANUAL" as const,
    };

    try {
      const outcome = await runDistributionExecuteOrInline(
        {
          organizationId,
          triggerSource: "MANUAL",
          conversationId: parsed.data.conversationId ?? null,
          contactId: parsed.data.contactId ?? null,
          dealId: parsed.data.dealId ?? null,
          departmentId,
          departmentIds: departmentIds.length > 0 ? departmentIds : null,
          reassign: parsed.data.reassign === true,
          distributionType: parsed.data.distributionType ?? null,
          requestedByUserId: session.user.id,
          correlationId: randomUUID(),
        },
        () => executeDistribution(executeInput),
      );

      if (outcome.kind === "result") {
        return NextResponse.json(outcome.result);
      }
      if (outcome.kind === "queued") {
        return NextResponse.json(
          { queued: true, jobId: outcome.jobId },
          { status: 202 },
        );
      }

      metrics.errors.inc({
        scope: "distribution.execute",
        kind: "queue_unavailable",
      });
      console.warn(
        "[POST /api/distribution/execute] fila indisponível — sem fallback em prod",
      );
      return NextResponse.json(
        { message: "Fila de distribuição indisponível. Tente novamente." },
        { status: 503 },
      );
    } catch (e) {
      console.error("[POST /api/distribution/execute]", e);
      return NextResponse.json(
        { message: "Erro ao executar distribuição." },
        { status: 500 },
      );
    }
  });
}
