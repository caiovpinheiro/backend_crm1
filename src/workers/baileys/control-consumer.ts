import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import {
  BAILEYS_CONTROL_QUEUE_NAME,
  type BaileysControlPayload,
} from "@/lib/queue";
import type { BaileysManager } from "./baileys-manager";

export function startControlConsumer(
  manager: BaileysManager,
  redisUrl: string,
): Worker<BaileysControlPayload> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<BaileysControlPayload>(
    BAILEYS_CONTROL_QUEUE_NAME,
    async (job: Job<BaileysControlPayload>) => {
      const { channelId, action } = job.data;
      console.info(`[baileys-control] ${action} para canal ${channelId}`);

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
          console.warn(`[baileys-control] ação desconhecida: ${action}`);
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`[baileys-control] job ${job?.id} falhou:`, err.message);
  });

  worker.on("completed", (job) => {
    console.info(`[baileys-control] job ${job.id} concluído`);
  });

  console.info(`[baileys-control] ouvindo fila "${BAILEYS_CONTROL_QUEUE_NAME}"`);
  return worker;
}
