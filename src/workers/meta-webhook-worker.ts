import { Worker, type Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import {
  duplicateBullConnection,
  getBullConnection,
} from "@/lib/queue-connection";
import {
  META_WEBHOOK_QUEUE_NAME,
  type MetaWebhookJobPayload,
} from "@/lib/queue";
import { withSystemContext } from "@/lib/webhook-context";
import { processStoredMetaWebhookEvent } from "@/lib/meta-webhook/handler";
import { flushStatusWrites } from "@/lib/status-write-buffer";
import { drainInFlightTurns } from "@/services/ai/turn-manager";
import { startAiTurnSweeper, stopAiTurnSweeper } from "@/services/ai/turn-sweeper";
import { startListenSweeper, stopListenSweeper } from "@/services/ai-v2/listen";
import { installGracefulShutdown, type ShutdownStep } from "@/workers/graceful-shutdown";

const log = getLogger("worker.meta-webhook");

/**
 * Worker BullMQ dedicado que consome a fila `meta-webhook-events`.
 *
 * Motivo: webhooks Meta (status sent/delivered/read de campanha + mensagens
 * inbound) eram processados síncronos na API do inbox. Em disparos em massa
 * isso satura o event loop + pool Prisma + Postgres e derruba
 * GET /api/conversations (skeleton na UI). A API agora só valida assinatura,
 * persiste `MetaWebhookEvent` e enfileira; este worker executa o loop pesado.
 *
 * Multi-tenant: workers rodam fora de RequestContext — embrulhamos em
 * `withSystemContext(organizationId)` (vem no payload, sem query extra).
 *
 * Concurrency: `META_WEBHOOK_WORKER_CONCURRENCY` (default 4) — deve ficar
 * ≤ `DB_POOL_MAX` do processo (default worker=4). Default antigo 8 estourava
 * o pool pg ("timeout exceeded when trying to connect") sob campanha.
 */

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

async function processMetaWebhookJob(
  job: Job<MetaWebhookJobPayload>,
): Promise<void> {
  const { metaWebhookEventId, organizationId } = job.data;
  const jobCtx = log.child({
    metaWebhookEventId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
  });

  if (!organizationId) {
    jobCtx.warn("Job sem organizationId — descartando");
    return;
  }

  await withSystemContext(organizationId, async () => {
    await processStoredMetaWebhookEvent(metaWebhookEventId);
  });
}

export function startMetaWebhookWorker() {
  const concurrency = envInt("META_WEBHOOK_WORKER_CONCURRENCY", 4);
  const connection = duplicateBullConnection();
  // Inicializa o singleton de filas (produtores no mesmo processo, ex.:
  // fallback de re-enqueue de backlog).
  getBullConnection();

  const worker = new Worker<MetaWebhookJobPayload>(
    META_WEBHOOK_QUEUE_NAME,
    processMetaWebhookJob,
    { connection, concurrency },
  );

  worker.on("completed", (job) => {
    log.info(
      { metaWebhookEventId: job.data.metaWebhookEventId, jobId: job.id },
      "Webhook Meta processado",
    );
  });

  worker.on("failed", (job, err) => {
    log.error(
      {
        metaWebhookEventId: job?.data.metaWebhookEventId,
        jobId: job?.id,
        attempt: (job?.attemptsMade ?? 0) + 1,
        err: err?.message ?? String(err),
      },
      "Falha ao processar webhook Meta",
    );
  });

  worker.on("error", (err) => {
    log.error({ err: err?.message ?? String(err) }, "Erro no worker meta-webhook");
  });

  // Tick que promove turnos vencidos e recupera PROCESSING travado. Este
  // worker ingere o inbound Meta, então o turno nasce aqui. Sobe já no boot
  // (o motor v2 usa turnos com ou sem AI_TURN_MANAGER): sem isso, depois de
  // um deploy os turnos órfãos esperavam o primeiro inbound para ter quem os
  // recuperasse.
  startAiTurnSweeper({ force: true });
  // Escutar a equipe: lê em lote as conversas das escutas ligadas.
  startListenSweeper();

  log.info({ concurrency }, "worker-meta-webhook iniciado");
  return worker;
}

/** Passos do SIGTERM (teto de 25 s em `installGracefulShutdown`). */
function metaWebhookShutdownSteps(worker: Pick<Worker, "close">): ShutdownStep[] {
  return [
    {
      name: "sweepers",
      run: () => {
        stopAiTurnSweeper();
        stopListenSweeper();
      },
    },
    // Turnos da IA em execução: esperam até AI_TURN_SHUTDOWN_DRAIN_MS e os
    // que não terminam voltam para READY, para o próximo processo retomar
    // no 1º tick em vez de ficarem presos em PROCESSING.
    {
      name: "turnos",
      run: () => drainInFlightTurns(envInt("AI_TURN_SHUTDOWN_DRAIN_MS", 7000)),
    },
    // Flush dos status bufferizados ANTES de fechar — o handler já respondeu 200
    // ("accepted") e a Meta não reenvia, então um status pendente se perderia.
    { name: "status-flush", run: () => flushStatusWrites() },
    { name: "bullmq", run: () => worker.close() },
    // Jobs que terminaram durante o close() podem ter bufferizado mais status.
    { name: "status-flush-final", run: () => flushStatusWrites() },
    { name: "prisma", run: () => prismaBase.$disconnect() },
  ];
}

if (require.main === module) {
  const worker = startMetaWebhookWorker();
  installGracefulShutdown({
    name: "worker-meta-webhook",
    log,
    steps: metaWebhookShutdownSteps(worker),
  });
}
