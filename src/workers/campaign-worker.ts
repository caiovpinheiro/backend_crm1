/**
 * worker-whatsapp — inbox (texto + mídia Meta) e sweepers de sessão.
 * NÃO consome campaign-dispatch / campaign-send nem sobe o rodízio.
 * Blast CRM: APP_MODE=worker-campaigns → campaigns-worker.ts.
 */
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "@/lib/prisma";
import { withSystemContext } from "@/lib/webhook-context";
import {
  META_ATTACH_QUEUE_NAME,
  META_OUTBOUND_QUEUE_NAME,
  type MetaAttachPayload,
  type MetaOutboundPayload,
} from "@/lib/queue";
import { processMetaAttach } from "@/jobs/whatsapp/meta-attach.job";
import { processMetaOutbound } from "@/jobs/whatsapp/meta-outbound.job";
import { startWhatsappOwnedSweepers } from "@/lib/sse-bus";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import { stopBackgroundTimers } from "@/lib/background-timers";
import { installGracefulShutdown } from "@/workers/graceful-shutdown";

const log = getLogger("worker.campaign");

function envPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for worker-whatsapp");
  return url;
}

async function markInboxJobFailed(opts: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  error: string;
}) {
  const updated = await prisma.message
    .updateMany({
      where: { id: opts.messageId, sendStatus: "pending" },
      data: { sendStatus: "failed", sendError: opts.error },
    })
    .catch(() => null);
  if (!updated || updated.count === 0) return;
  await prisma.conversation
    .update({
      where: { id: opts.conversationId },
      data: { hasError: true },
    })
    .catch(() => {});
  const { publishMessageStatus } = await import("@/lib/realtime-events");
  try {
    publishMessageStatus({
      organizationId: opts.organizationId,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      internalId: opts.messageId,
      status: "failed",
      error: opts.error,
    });
  } catch {
    /* best-effort */
  }
}

export function startCampaignWorkers() {
  const redisUrl = getRedisUrl();
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const attachConcurrency = envPositiveInt("META_ATTACH_CONCURRENCY", 2);
  const attachWorker = new Worker<MetaAttachPayload>(
    META_ATTACH_QUEUE_NAME,
    async (job: Job<MetaAttachPayload>) => {
      await withSystemContext(job.data.organizationId, () =>
        processMetaAttach(job.data),
      );
    },
    { connection, concurrency: attachConcurrency },
  );
  attachWorker.on("failed", (job, err) => {
    log.error(
      {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        err: err instanceof Error ? err.message : err,
      },
      "[meta-attach] job falhou",
    );
    if (!job?.data) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    const error =
      err instanceof Error ? err.message : "Falha no envio de mídia";
    void withSystemContext(job.data.organizationId, () =>
      markInboxJobFailed({
        organizationId: job.data.organizationId,
        conversationId: job.data.conversationId,
        messageId: job.data.messageId,
        error,
      }),
    );
  });
  attachWorker.on("completed", (job) => {
    log.info({ jobId: job.id }, "[meta-attach] job concluído");
  });

  const outboundConcurrency = envPositiveInt("META_OUTBOUND_CONCURRENCY", 4);
  const outboundWorker = new Worker<MetaOutboundPayload>(
    META_OUTBOUND_QUEUE_NAME,
    async (job: Job<MetaOutboundPayload>) => {
      await withSystemContext(job.data.organizationId, () =>
        processMetaOutbound(job.data),
      );
    },
    { connection: connection.duplicate(), concurrency: outboundConcurrency },
  );
  outboundWorker.on("failed", (job, err) => {
    log.error(
      {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        err: err instanceof Error ? err.message : err,
      },
      "[meta-outbound] job falhou",
    );
    if (!job?.data) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;
    const error =
      err instanceof Error ? err.message : "Falha no envio de texto";
    void withSystemContext(job.data.organizationId, () =>
      markInboxJobFailed({
        organizationId: job.data.organizationId,
        conversationId: job.data.conversationId,
        messageId: job.data.messageId,
        error,
      }),
    );
  });
  outboundWorker.on("completed", (job) => {
    log.info({ jobId: job.id }, "[meta-outbound] job concluído");
  });

  log.info({ attachConcurrency, outboundConcurrency }, "[campaign-worker] inbox Meta started");

  startWhatsappOwnedSweepers();
  log.info("[campaign-worker] sweepers sessão/stale/presença/agendadas/IA/push iniciados");

  return { attachWorker, outboundWorker };
}

if (require.main === module) {
  const { attachWorker, outboundWorker } = startCampaignWorkers();
  installGracefulShutdown({
    name: "worker-whatsapp",
    log,
    steps: [
      // Sweepers (presença, agendadas, IA, push, outbox): nenhum ciclo novo.
      { name: "sweepers", run: () => stopBackgroundTimers() },
      {
        // close() espera o envio em andamento — sem isso o job vira stalled
        // e outro worker reenvia a mensagem na Meta.
        name: "workers",
        run: () => Promise.all([attachWorker.close(), outboundWorker.close()]),
      },
      { name: "prisma", run: () => prismaBase.$disconnect() },
    ],
  });
}
