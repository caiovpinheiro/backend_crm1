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
import { startAiTurnSweeper } from "@/services/ai/turn-sweeper";

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

  // Turn Manager (AI_TURN_MANAGER=1): tick que promove turnos vencidos e
  // recupera PROCESSING travado. No-op com a flag desligada. É aqui porque
  // este worker é quem ingere o inbound Meta — o turno nasce neste processo.
  startAiTurnSweeper();

  log.info({ concurrency }, "worker-meta-webhook iniciado");
  return worker;
}

async function shutdown(worker: Worker): Promise<void> {
  log.info("Encerrando worker-meta-webhook...");
  // Flush dos status bufferizados ANTES de fechar — o handler já respondeu 200
  // ("accepted") e a Meta não reenvia, então um status pendente se perderia.
  await flushStatusWrites().catch(() => {});
  await worker.close().catch(() => {});
  await prismaBase.$disconnect().catch(() => {});
  process.exit(0);
}

if (require.main === module) {
  const worker = startMetaWebhookWorker();
  process.on("SIGINT", () => void shutdown(worker));
  process.on("SIGTERM", () => void shutdown(worker));
}
