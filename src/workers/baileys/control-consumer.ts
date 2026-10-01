import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import {
  BAILEYS_CONTROL_QUEUE_NAME,
  type BaileysControlPayload,
} from "@/lib/queue";
import type { BaileysManager } from "./baileys-manager";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys.control-consumer");

export function startControlConsumer(
  manager: BaileysManager,
  redisUrl: string,
): Worker<BaileysControlPayload> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<BaileysControlPayload>(
    BAILEYS_CONTROL_QUEUE_NAME,
    async (job: Job<BaileysControlPayload>) => {
      const { channelId, action } = job.data;
      log.info({ action, channelId }, "[baileys-control] ação recebida");

      switch (action) {
        case "connect":
          await manager.connect(channelId);
          break;
        case "disconnect":
          await manager.disconnect(channelId);
          break;
        case "logout":
          await manager.logout(channelId);
          break;
        case "sync-groups":
          await manager.syncGroups(channelId);
          break;
        default:
          log.warn({ action }, "[baileys-control] ação desconhecida");
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, "[baileys-control] job falhou");
  });

  worker.on("completed", (job) => {
    log.info({ jobId: job.id }, "[baileys-control] job concluído");
  });

  log.info({ queue: BAILEYS_CONTROL_QUEUE_NAME }, "[baileys-control] ouvindo fila");
  return worker;
}
