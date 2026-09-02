/**
 * Snapshot de profundidade das filas BullMQ para expor via Prometheus.
 *
 * Chamado por `renderMetrics()` a cada scrape do /api/metrics. Instancia
 * `Queue` leve (sem worker) apenas para chamar `getJobCounts`. Cada Queue
 * segura sua propria conexao IORedis (via BullMQ), reaproveitada pelo
 * singleton do processo — nao vaza sockets em hot-reload gracas ao
 * `globalThis` usado em src/lib/queue.ts.
 *
 * Se REDIS_URL nao estiver setado, retorna cedo sem tocar nas metricas.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";

import { DISTRIBUTION_DRAIN_QUEUE_NAME } from "@/lib/distribution-drain-queue";
import { DISTRIBUTION_EXECUTE_QUEUE_NAME } from "@/lib/distribution-execute-queue";
import { metrics } from "@/lib/metrics";
import {
  AUTOMATION_JOBS_QUEUE_NAME,
  BAILEYS_OUTBOUND_QUEUE_NAME,
  BAILEYS_CONTROL_QUEUE_NAME,
  CAMPAIGN_DISPATCH_QUEUE_NAME,
  CAMPAIGN_SEND_QUEUE_NAME,
  LEADS_BULK_QUEUE_NAME,
  IMPORT_ETL_QUEUE_NAME,
  META_WEBHOOK_QUEUE_NAME,
} from "@/lib/queue";

const QUEUE_NAMES = [
  AUTOMATION_JOBS_QUEUE_NAME,
  BAILEYS_OUTBOUND_QUEUE_NAME,
  BAILEYS_CONTROL_QUEUE_NAME,
  CAMPAIGN_DISPATCH_QUEUE_NAME,
  CAMPAIGN_SEND_QUEUE_NAME,
  LEADS_BULK_QUEUE_NAME,
  IMPORT_ETL_QUEUE_NAME,
  META_WEBHOOK_QUEUE_NAME,
  DISTRIBUTION_DRAIN_QUEUE_NAME,
  DISTRIBUTION_EXECUTE_QUEUE_NAME,
] as const;

type QueueName = (typeof QUEUE_NAMES)[number];

const globalForQueueMetrics = globalThis as unknown as {
  __queueMetricsRedis?: IORedis;
  __queueMetricsQueues?: Map<QueueName, Queue>;
};

function getRedis(): IORedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!globalForQueueMetrics.__queueMetricsRedis) {
    globalForQueueMetrics.__queueMetricsRedis = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    globalForQueueMetrics.__queueMetricsRedis.on("error", () => {
      // silencia — o snapshot degrada gracefully para zero.
    });
  }
  return globalForQueueMetrics.__queueMetricsRedis;
}

function getQueues(): Map<QueueName, Queue> | null {
  const redis = getRedis();
  if (!redis) return null;
  if (!globalForQueueMetrics.__queueMetricsQueues) {
    const m = new Map<QueueName, Queue>();
    for (const name of QUEUE_NAMES) {
      m.set(name, new Queue(name, { connection: redis }));
    }
    globalForQueueMetrics.__queueMetricsQueues = m;
  }
  return globalForQueueMetrics.__queueMetricsQueues;
}

export async function collectQueueDepth(): Promise<void> {
  const queues = getQueues();
  if (!queues) return;

  await Promise.all(
    Array.from(queues.entries()).map(async ([name, queue]) => {
      try {
        const counts = await queue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
          "completed",
        );
        for (const [state, value] of Object.entries(counts)) {
          metrics.bullmq.queueDepth.set({ queue: name, state }, Number(value) || 0);
        }
      } catch {
        // ignora — Redis pode estar indisponivel; deixa o valor antigo (ou zero).
      }
    }),
  );
}
