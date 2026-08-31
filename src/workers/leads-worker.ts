import { Worker, type Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import {
  duplicateBullConnection,
  getBullConnection,
} from "@/lib/queue-connection";
import {
  LEADS_BULK_JOB_NAMES,
  LEADS_BULK_QUEUE_NAME,
  type BulkAssignConversationsPayload,
  type BulkMoveStagePayload,
  type BulkResolveConversationsPayload,
  type BulkUpdateFieldsPayload,
  type LeadsBulkPayload,
} from "@/lib/queue";
import { withSystemContext } from "@/lib/webhook-context";

import { processBulkAssignConversations } from "@/jobs/leads/bulk-assign-conversations.job";
import { processBulkMoveStage } from "@/jobs/leads/bulk-move-stage.job";
import { processBulkResolveConversations } from "@/jobs/leads/bulk-resolve-conversations.job";
import { processBulkUpdateFields } from "@/jobs/leads/bulk-update-fields.job";
import {
  markOperationFailed,
  truncateErrorMessage,
} from "@/jobs/leads/_update-progress";

const log = getLogger("worker.leads");

/**
 * Worker BullMQ que consome a fila `leads-bulk`.
 *
 * Multi-tenant (cuidado importante):
 *   - Workers rodam fora de qualquer RequestContext (sem session NextAuth
 *     e sem AsyncLocalStorage configurado).
 *   - `prisma` (cliente scoped via extension) exige RequestContext —
 *     usar fora dele lança "chamado fora de RequestContext".
 *   - Solução: resolver organizationId a partir do payload do job e
 *     embrulhar a execução do handler em `withSystemContext`.
 *   - Defesa em profundidade: re-buscar `BulkOperation` via `prismaBase`
 *     (sem scope) e validar que o `organizationId` do payload coincide
 *     com o do registro — protege contra payloads forjados.
 *
 * Concurrency:
 *   - Configurável via `LEADS_BULK_CONCURRENCY` (default 5). Múltiplos
 *     jobs podem rodar em paralelo no MESMO processo worker; isso aumenta
 *     throughput quando há vários BulkOperations pequenos pendentes.
 *   - Cada job processa seus próprios chunks sequencialmente.
 *   - O pool default de `worker-leads` (10, ver `defaultPoolMax`) cobre a
 *     concurrency 5 mais o semáforo de efeitos colaterais do
 *     bulk-move-stage. Ao subir `LEADS_BULK_CONCURRENCY`, suba também
 *     `DB_POOL_MAX` — pool menor que a demanda faz o job esperar conexão
 *     na fila interna do pg-pool e falhar por timeout.
 *
 * Retries:
 *   - Configurados no produtor (`enqueueLeadsBulk`).
 *   - Re-throw aqui causa retry; erros por-item NÃO causam re-throw
 *     porque são absorvidos nos handlers (registrados em
 *     `BulkOperation.errors`).
 *   - Tipos de erro que devem causar retry: DB down, conflito de
 *     transação. Esses chegam aqui via exception não-capturada no
 *     handler.
 */

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

async function router(job: Job<LeadsBulkPayload>): Promise<void> {
  const { operationId, organizationId } = job.data;
  const jobCtx = log.child({
    operationId,
    organizationId,
    jobId: job.id,
    jobName: job.name,
    attempt: job.attemptsMade + 1,
  });

  // Re-busca em prismaBase para validar que o BulkOperation existe e
  // pertence à org informada no payload. Se não bater, falha o job —
  // não tentar adivinhar org.
  const operation = await prismaBase.bulkOperation.findUnique({
    where: { id: operationId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      type: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });

  if (!operation) {
    jobCtx.error("BulkOperation não encontrada — descartando job");
    // NÃO re-throw — esse job nunca vai ter sucesso; deixar BullMQ
    // descartar (removeOnFail: false manterá o registro em failed para
    // auditoria, mas attempts vão consumir até cap).
    throw new Error(`BulkOperation ${operationId} não encontrada`);
  }

  if (operation.organizationId !== organizationId) {
    jobCtx.error(
      { dbOrgId: operation.organizationId },
      "organizationId do payload diverge do BulkOperation",
    );
    await markOperationFailed(
      operationId,
      operation.organizationId,
      "organizationId do job não corresponde ao BulkOperation",
    );
    return;
  }

  if (
    operation.status === "COMPLETED" ||
    operation.status === "FAILED" ||
    operation.status === "PARTIAL" ||
    operation.status === "CANCELLED"
  ) {
    // Operação já finalizada — pode acontecer em retry do BullMQ depois
    // que um handler terminou ok mas o ack falhou. Não fazer nada.
    jobCtx.info(
      { dbStatus: operation.status },
      "BulkOperation já finalizada — ignorando job",
    );
    return;
  }

  // Executa o handler dentro do contexto de tenant. O ator é quem disparou a
  // operação na tela — sem isso o `logEvent` cai no default SYSTEM e a
  // timeline mostra "Sistema" em vez do nome de quem encerrou/moveu em massa.
  const initiator = operation.createdBy;
  const initiatorLabel =
    initiator?.name?.trim() || initiator?.email?.trim() || null;
  await withSystemContext(organizationId, () => dispatch(job), {
    // `userId` alimenta o FK `actorUserId` do ActivityEvent (a extension do
    // Prisma só usa organizationId, então isto não afeta escopo).
    userId: initiator?.id,
    actor: initiatorLabel
      ? { type: "HUMAN", label: initiatorLabel }
      : undefined,
  });
}

async function dispatch(job: Job<LeadsBulkPayload>): Promise<void> {
  switch (job.name) {
    case LEADS_BULK_JOB_NAMES.bulkUpdateFields:
      await processBulkUpdateFields(
        job.data as BulkUpdateFieldsPayload,
        job as Job<BulkUpdateFieldsPayload>,
      );
      return;
    case LEADS_BULK_JOB_NAMES.bulkMoveStage:
      await processBulkMoveStage(
        job.data as BulkMoveStagePayload,
        job as Job<BulkMoveStagePayload>,
      );
      return;
    case LEADS_BULK_JOB_NAMES.bulkResolveConversations:
      await processBulkResolveConversations(
        job.data as BulkResolveConversationsPayload,
        job as Job<BulkResolveConversationsPayload>,
      );
      return;
    case LEADS_BULK_JOB_NAMES.bulkAssignConversations:
      await processBulkAssignConversations(
        job.data as BulkAssignConversationsPayload,
        job as Job<BulkAssignConversationsPayload>,
      );
      return;
    default: {
      // Job name desconhecido — possivelmente versão antiga do produtor.
      // Falhar limpo em vez de processar payload errado.
      const { operationId, organizationId } = job.data;
      await markOperationFailed(
        operationId,
        organizationId,
        `Job name desconhecido: ${job.name}`,
      );
      throw new Error(`[leads-worker] Job name desconhecido: ${job.name}`);
    }
  }
}

export function startLeadsWorker() {
  const concurrency = envInt("LEADS_BULK_CONCURRENCY", 5);
  // duplicate() para o socket do Worker ficar separado das filas Queue.
  const connection = duplicateBullConnection();
  // Força inicialização da conexão de filas (Queue producer) para garantir
  // que o singleton em queue-connection.ts esteja vivo antes do Worker
  // começar a puxar jobs (importante quando handlers enfileiram jobs
  // adicionais no futuro).
  getBullConnection();

  const worker = new Worker<LeadsBulkPayload>(
    LEADS_BULK_QUEUE_NAME,
    router,
    { connection, concurrency },
  );

  worker.on("completed", (job) => {
    log.info(
      {
        operationId: job.data.operationId,
        organizationId: job.data.organizationId,
        jobId: job.id,
        jobName: job.name,
      },
      "Job concluído",
    );
  });

  worker.on("failed", (job, err) => {
    log.error(
      {
        operationId: job?.data.operationId,
        organizationId: job?.data.organizationId,
        jobId: job?.id,
        jobName: job?.name,
        attempt: (job?.attemptsMade ?? 0) + 1,
        err: truncateErrorMessage(err),
      },
      "Job falhou",
    );
  });

  worker.on("error", (err) => {
    log.error({ err: truncateErrorMessage(err) }, "Worker error");
  });

  log.info({ concurrency, queue: LEADS_BULK_QUEUE_NAME }, "leads-worker started");

  // Graceful shutdown — fecha o worker e a conexão antes de matar o processo.
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Recebido sinal de shutdown — fechando worker");
    try {
      await worker.close();
    } catch (err) {
      log.error({ err: truncateErrorMessage(err) }, "Erro ao fechar worker");
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return worker;
}

// Bootstrap quando executado diretamente (npm script ou node dist/.../leads-worker.js).
// Em CJS bundle do esbuild, `require.main === module` continua funcionando.
if (require.main === module) {
  startLeadsWorker();
}
