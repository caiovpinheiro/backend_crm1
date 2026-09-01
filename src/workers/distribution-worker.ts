import { Worker } from "bullmq";

import { getLogger } from "@/lib/logger";
import {
  duplicateBullConnection,
  getBullConnection,
} from "@/lib/queue-connection";
import {
  DISTRIBUTION_DRAIN_QUEUE_NAME,
  type DistributionDrainPayload,
} from "@/lib/distribution-drain-queue";
import { processDistributionDrainJob } from "@/jobs/distribution/process-pending.job";
import { truncateErrorMessage } from "@/jobs/leads/_update-progress";

const log = getLogger("worker.distribution");

/**
 * Worker BullMQ dedicado à fila `distribution-drain`.
 *
 * Consome `processDistributionDrainJob` → `processPendingDistributionQueue`
 * via `withSystemContext`. Único consumidor de `distribution-drain`.
 */

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

export function startDistributionWorker() {
  const concurrency = envInt("DISTRIBUTION_DRAIN_CONCURRENCY", 1);
  const connection = duplicateBullConnection();
  getBullConnection();

  const worker = new Worker<DistributionDrainPayload>(
    DISTRIBUTION_DRAIN_QUEUE_NAME,
    async (job) => {
      await processDistributionDrainJob(job.data);
    },
    { connection, concurrency },
  );

  worker.on("completed", (job) => {
    log.info(
      {
        organizationId: job.data.organizationId,
        trigger: job.data.trigger,
        jobId: job.id,
      },
      "drain job done",
    );
  });

  worker.on("failed", (job, err) => {
    log.error(
      {
        organizationId: job?.data.organizationId,
        trigger: job?.data.trigger,
        jobId: job?.id,
        attempt: (job?.attemptsMade ?? 0) + 1,
        err: truncateErrorMessage(err),
      },
      "distribution-drain falhou",
    );
  });

  worker.on("error", (err) => {
    log.error({ err: truncateErrorMessage(err) }, "distribution-drain worker error");
  });

  log.info(
    { concurrency, queue: DISTRIBUTION_DRAIN_QUEUE_NAME },
    "distribution-worker started",
  );

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

if (require.main === module) {
  startDistributionWorker();
}
