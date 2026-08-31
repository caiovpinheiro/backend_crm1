import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { markOperationCancelled } from "@/jobs/leads/_update-progress";
import { prisma } from "@/lib/prisma";
import { removeQueuedBulkJobs } from "@/lib/queue";

type Ctx = { params: Promise<{ id: string }> };

/** Tamanho máximo de `errors[]` retornado ao cliente. Trunca para não inflar payload. */
const MAX_ERRORS_IN_RESPONSE = 100;

/**
 * GET /api/bulk-operations/[id]
 *
 * Retorna o estado atual de uma operação em massa para que o frontend
 * pollar progresso após enfileirar via /api/deals/bulk* (modo async).
 *
 * Multi-tenant: a Prisma extension de scope filtra automaticamente por
 * `organizationId` da sessão — não há risco de leak cross-org.
 *
 * Auth: qualquer usuário autenticado da org pode ver. Pode-se restringir
 * a "operação criada pelo próprio user" em iteração futura via
 * `where.createdById = session.user.id`.
 */
export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async () => {
    const { id } = await ctx.params;
    const op = await prisma.bulkOperation.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        total: true,
        processed: true,
        succeeded: true,
        failed: true,
        errors: true,
        payload: true,
        createdById: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    if (!op) {
      return NextResponse.json(
        { message: "Operação não encontrada." },
        { status: 404 },
      );
    }

    const errorsArray = Array.isArray(op.errors)
      ? (op.errors as Array<Record<string, unknown>>)
      : [];
    const truncatedErrors = errorsArray.slice(0, MAX_ERRORS_IN_RESPONSE);

    const progressPercent =
      op.total > 0
        ? Math.min(100, Math.round((op.processed / op.total) * 100))
        : op.status === "COMPLETED" || op.status === "PARTIAL"
          ? 100
          : 0;

    return NextResponse.json({
      id: op.id,
      type: op.type,
      status: op.status,
      total: op.total,
      processed: op.processed,
      succeeded: op.succeeded,
      failed: op.failed,
      progressPercent,
      errors: truncatedErrors,
      errorsTruncated: errorsArray.length > MAX_ERRORS_IN_RESPONSE,
      createdById: op.createdById,
      createdAt: op.createdAt,
      startedAt: op.startedAt,
      finishedAt: op.finishedAt,
      payload: op.payload,
    });
  });
}

/**
 * POST /api/bulk-operations/[id]
 * Cancela uma operação ainda PENDING/PROCESSING.
 */
export async function POST(_req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    const { id } = await ctx.params;
    const orgId = (session.user as { organizationId?: string | null }).organizationId;
    if (!orgId) {
      return NextResponse.json({ message: "Operação requer organização." }, { status: 403 });
    }

    const op = await prisma.bulkOperation.findUnique({
      where: { id },
      select: { id: true, status: true, organizationId: true },
    });
    if (!op) {
      return NextResponse.json({ message: "Operação não encontrada." }, { status: 404 });
    }

    if (
      op.status === "COMPLETED" ||
      op.status === "PARTIAL" ||
      op.status === "FAILED" ||
      op.status === "CANCELLED"
    ) {
      return NextResponse.json({
        message: "Operação já finalizada.",
        id: op.id,
        status: op.status,
      });
    }

    const cancelled = await markOperationCancelled(id, orgId);
    if (cancelled) {
      await removeQueuedBulkJobs(id).catch(() => 0);
    }

    const fresh = await prisma.bulkOperation.findUnique({
      where: { id },
      select: { id: true, status: true, processed: true, total: true },
    });
    return NextResponse.json({
      message: cancelled ? "Operação cancelada." : "Não foi possível cancelar.",
      id: fresh?.id ?? id,
      status: fresh?.status ?? op.status,
      processed: fresh?.processed ?? 0,
      total: fresh?.total ?? 0,
    });
  });
}
