import { Worker } from "bullmq";

import { waitUntilCacheReady } from "@/lib/cache";
import { getLogger } from "@/lib/logger";
import {
  duplicateBullConnection,
  waitUntilBullReady,
} from "@/lib/queue-connection";
import { waitForRedisWritable } from "@/lib/redis-ready";
import {
  DISTRIBUTION_DRAIN_QUEUE_NAME,
  type DistributionDrainPayload,
} from "@/lib/distribution-drain-queue";
import {
  DISTRIBUTION_EXECUTE_JOB_NAME,
  DISTRIBUTION_EXECUTE_QUEUE_NAME,
  DISTRIBUTION_REDISTRIBUTE_JOB_NAME,
  DISTRIBUTION_STUCK_INBOUND_JOB_NAME,
  type DistributionExecuteJobData,
} from "@/lib/distribution-execute-queue";
import { processDistributionDrainJob } from "@/jobs/distribution/process-pending.job";
import { processDistributionExecuteJob } from "@/jobs/distribution/execute.job";
import { processDistributionRedistributeJob } from "@/jobs/distribution/redistribute.job";
import { processDistributionStuckInboundJob } from "@/jobs/distribution/stuck-inbound.job";
import { truncateErrorMessage } from "@/jobs/leads/_update-progress";

const log = getLogger("worker.distribution");

/**
 * Worker BullMQ: `distribution-drain` (concurrency 1) + `distribution-execute`
 * (2–4). Drain e motor no mesmo processo; pool DB default ~4.
 */

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

export async function startDistributionWorker() {
  const drainConcurrency = envInt("DISTRIBUTION_DRAIN_CONCURRENCY", 1);
  const executeConcurrency = Math.min(
    4,
    envInt("DISTRIBUTION_EXECUTE_CONCURRENCY", 2),
  );
  const drainConnection = duplicateBullConnection();
  const executeConnection = duplicateBullConnection();

  const REDIS_WAIT_MS = 8_000;
  const [bullOk, workerConnOk, cacheOk] = await Promise.all([
    waitUntilBullReady(REDIS_WAIT_MS),
    waitForRedisWritable(drainConnection, REDIS_WAIT_MS),
    waitUntilCacheReady(REDIS_WAIT_MS),
  ]);
  if (!bullOk || !workerConnOk || !cacheOk) {
    log.warn(
      {
        bullReady: bullOk,
        workerConnReady: workerConnOk,
        cacheReady: cacheOk,
      },
      "redis ainda não ready — Worker sobe; cache/cooldown usam fallback até o socket gravar",
    );
  }

  const drainWorker = new Worker<DistributionDrainPayload>(
    DISTRIBUTION_DRAIN_QUEUE_NAME,
    async (job) => {
      await processDistributionDrainJob(job.data);
    },
    { connection: drainConnection, concurrency: drainConcurrency },
  );

  const executeWorker = new Worker<DistributionExecuteJobData>(
    DISTRIBUTION_EXECUTE_QUEUE_NAME,
    async (job) => {
      if (job.name === DISTRIBUTION_REDISTRIBUTE_JOB_NAME) {
        return processDistributionRedistributeJob(
          job.data as Parameters<typeof processDistributionRedistributeJob>[0],
        );
      }
      if (job.name === DISTRIBUTION_STUCK_INBOUND_JOB_NAME) {
        return processDistributionStuckInboundJob(
          job.data as Parameters<typeof processDistributionStuckInboundJob>[0],
        );
      }
      if (job.name !== DISTRIBUTION_EXECUTE_JOB_NAME) {
        log.warn({ jobName: job.name }, "job name desconhecido — tratando como execute");
      }
      return processDistributionExecuteJob(
        job.data as Parameters<typeof processDistributionExecuteJob>[0],
      );
    },
    { connection: executeConnection, concurrency: executeConcurrency },
  );

  drainWorker.on("completed", (job) => {
    log.info(
      {
        organizationId: job.data.organizationId,
        trigger: job.data.trigger,
        jobId: job.id,
      },
      "drain job done",
    );
  });

  drainWorker.on("failed", (job, err) => {
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

  drainWorker.on("error", (err) => {
    log.error({ err: truncateErrorMessage(err) }, "distribution-drain worker error");
  });

  executeWorker.on("completed", (job) => {
    log.info(
      {
        jobName: job.name,
        jobId: job.id,
        organizationId:
          "organizationId" in job.data ? job.data.organizationId : null,
      },
      "execute job done",
    );
  });

  executeWorker.on("failed", (job, err) => {
    log.error(
      {
        jobName: job?.name,
        jobId: job?.id,
        organizationId:
          job?.data && "organizationId" in job.data
            ? job.data.organizationId
            : null,
        attempt: (job?.attemptsMade ?? 0) + 1,
        err: truncateErrorMessage(err),
      },
      "distribution-execute falhou",
    );
  });

  executeWorker.on("error", (err) => {
    log.error(
      { err: truncateErrorMessage(err) },
      "distribution-execute worker error",
    );
  });

  log.info(
    {
      drainConcurrency,
      executeConcurrency,
      drainQueue: DISTRIBUTION_DRAIN_QUEUE_NAME,
      executeQueue: DISTRIBUTION_EXECUTE_QUEUE_NAME,
      redisReady: bullOk && workerConnOk && cacheOk,
    },
    "distribution-worker started",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Recebido sinal de shutdown — fechando worker");
    try {
      await Promise.all([drainWorker.close(), executeWorker.close()]);
    } catch (err) {
      log.error({ err: truncateErrorMessage(err) }, "Erro ao fechar worker");
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return { drainWorker, executeWorker };
}

if (require.main === module) {
  void startDistributionWorker().catch((err) => {
    log.error({ err: truncateErrorMessage(err) }, "distribution-worker falhou ao iniciar");
    process.exit(1);
  });
}
