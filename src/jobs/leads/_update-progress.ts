import { prismaBase } from "@/lib/prisma-base";
import type { Prisma } from "@prisma/client";

/**
 * Helpers de atualização do registro `BulkOperation` no Postgres.
 *
 * Decisão importante: usam `prismaBase` (sem extension de tenant). Os
 * handlers rodam dentro de `withSystemContext` (organizationId já validado
 * via payload do job), e atualizar `BulkOperation` precisa funcionar
 * mesmo se a Prisma extension não estiver carregada na imagem dos
 * workers compilados via esbuild — usar `prismaBase` evita acoplar com
 * detalhes da extension.
 *
 * Multi-tenant ainda é respeitado: todos os updates incluem
 * `organizationId` no WHERE como defesa em profundidade.
 */

/** Limite de entradas em `errors[]` no JSON; protege contra bloat de DB. */
const MAX_ERROR_ENTRIES = 500;

export type BulkOperationErrorEntry = {
  /** ID do item (deal) que falhou. Cuidado: sempre serializar como string. */
  itemId: string;
  /** Mensagem técnica do erro (truncada para 500 chars). */
  message: string;
  /** Tentativa do job (job.attemptsMade no momento do erro). */
  attempt: number;
  /** ISO8601. */
  at: string;
};

/** Marca o BulkOperation como PROCESSING e seta `startedAt`. Idempotente. */
export async function markOperationStarted(
  operationId: string,
  organizationId: string,
): Promise<void> {
  await prismaBase.bulkOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      status: "PENDING",
    },
    data: {
      status: "PROCESSING",
      startedAt: new Date(),
    },
  });
}

/**
 * Aplica um incremento atômico nos contadores de progresso. Pode ser
 * chamado várias vezes durante a execução do handler (uma por chunk),
 * permitindo que o frontend acompanhe o progresso quase em tempo real
 * via polling do endpoint GET /api/bulk-operations/[id].
 *
 * `failedErrors` é opcional — quando informado, faz append com cap em
 * `MAX_ERROR_ENTRIES` para evitar inflar o JSON em operações enormes.
 *
 * Por que não usar `prisma.$transaction`? Updates atômicos com
 * `increment` já são seguros para concorrência; transações
 * desnecessárias aumentam contenção em lock de linha quando dois chunks
 * do mesmo handler concorrem (raro mas possível em concurrency > 1).
 */
export async function incrementOperationProgress(
  operationId: string,
  organizationId: string,
  delta: {
    processed?: number;
    succeeded?: number;
    failed?: number;
  },
  failedErrors?: BulkOperationErrorEntry[],
): Promise<void> {
  // Append a lista de erros — fazer em duas operações (read+write) cap-
  // limitado é mais simples e suficiente: erro extra esporádico é
  // aceitável vs construir um Postgres jsonb_append complexo.
  let nextErrors: Prisma.InputJsonValue | undefined;
  if (failedErrors && failedErrors.length > 0) {
    const current = await prismaBase.bulkOperation.findUnique({
      where: { id: operationId },
      select: { errors: true },
    });
    const existing: BulkOperationErrorEntry[] = Array.isArray(current?.errors)
      ? (current!.errors as unknown as BulkOperationErrorEntry[])
      : [];
    const merged = [...existing, ...failedErrors].slice(0, MAX_ERROR_ENTRIES);
    nextErrors = merged as unknown as Prisma.InputJsonValue;
  }

  await prismaBase.bulkOperation.updateMany({
    where: { id: operationId, organizationId },
    data: {
      ...(delta.processed
        ? { processed: { increment: delta.processed } }
        : {}),
      ...(delta.succeeded
        ? { succeeded: { increment: delta.succeeded } }
        : {}),
      ...(delta.failed ? { failed: { increment: delta.failed } } : {}),
      ...(nextErrors !== undefined ? { errors: nextErrors } : {}),
    },
  });
}

/**
 * Finaliza a operação. Decide o status final com base nos contadores:
 *
 *  - failed == 0          → COMPLETED
 *  - succeeded > 0, failed > 0 → PARTIAL
 *  - succeeded == 0, failed > 0 → FAILED
 *
 * Idempotente — pode ser chamado mesmo se a operação já foi finalizada
 * por uma execução anterior do job (retry do BullMQ).
 */
export async function markOperationFinished(
  operationId: string,
  organizationId: string,
): Promise<void> {
  const op = await prismaBase.bulkOperation.findUnique({
    where: { id: operationId },
    select: { id: true, organizationId: true, succeeded: true, failed: true, status: true },
  });
  if (!op) return;
  if (op.organizationId !== organizationId) return;
  if (op.status === "COMPLETED" || op.status === "FAILED" || op.status === "PARTIAL" || op.status === "CANCELLED") {
    return;
  }
  const finalStatus =
    op.failed === 0 ? "COMPLETED" : op.succeeded === 0 ? "FAILED" : "PARTIAL";
  await prismaBase.bulkOperation.update({
    where: { id: operationId },
    data: {
      status: finalStatus,
      finishedAt: new Date(),
    },
  });
}

/** True se o usuário cancelou no meio do job — o handler deve parar. */
export async function isOperationCancelled(
  operationId: string,
  organizationId: string,
): Promise<boolean> {
  const op = await prismaBase.bulkOperation.findUnique({
    where: { id: operationId },
    select: { status: true, organizationId: true },
  });
  return (
    !!op &&
    op.organizationId === organizationId &&
    op.status === "CANCELLED"
  );
}

/** Marca PENDING/PROCESSING como CANCELLED. Idempotente. */
export async function markOperationCancelled(
  operationId: string,
  organizationId: string,
  reason = "Cancelado pelo usuário",
): Promise<boolean> {
  const result = await prismaBase.bulkOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
    data: {
      status: "CANCELLED",
      finishedAt: new Date(),
      errors: [
        {
          itemId: "__operation__",
          message: reason.slice(0, 500),
          attempt: 0,
          at: new Date().toISOString(),
        },
      ] as unknown as Prisma.InputJsonValue,
    },
  });
  return result.count > 0;
}

/**
 * Marca a operação como FAILED com motivo explícito — usar quando o
 * handler falha antes de processar qualquer item (validação, payload
 * inválido, dependência indisponível). NÃO usar para erro por-item.
 */
export async function markOperationFailed(
  operationId: string,
  organizationId: string,
  reason: string,
): Promise<void> {
  await prismaBase.bulkOperation.updateMany({
    where: {
      id: operationId,
      organizationId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      errors: [
        {
          itemId: "__operation__",
          message: reason.slice(0, 500),
          attempt: 0,
          at: new Date().toISOString(),
        },
      ] as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Trunca uma mensagem de erro para o tamanho máximo aceito no JSON
 * (~500 chars) — protege contra stacktraces gigantes acabarem em `errors`.
 */
export function truncateErrorMessage(input: unknown, max = 500): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : safeStringify(input);
  return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
