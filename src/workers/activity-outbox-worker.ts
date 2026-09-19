/**
 * Worker dedicado que consome a outbox do Activity Log.
 *
 * Roda em loop fazendo poll no Postgres com FOR UPDATE SKIP LOCKED.
 * Nao depende de Redis/BullMQ para a fila em si; pode ser sinalizado via
 * BullMQ no futuro se quisermos orquestrar multiplas instancias.
 */

import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import { cleanupActivityOutbox } from "@/services/activity-outbox";
import { startActivityOutboxWorker } from "@/services/activity-outbox";

const log = getLogger("worker.activity-outbox");

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

async function main() {
  const intervalMs = envInt("ACTIVITY_OUTBOX_POLL_MS", 5_000);
  const batchSize = envInt("ACTIVITY_OUTBOX_BATCH_SIZE", 100);
  const cleanupHours = envInt("ACTIVITY_OUTBOX_CLEANUP_HOURS", 24);

  log.info(
    `starting activity-outbox worker poll=${intervalMs}ms batch=${batchSize} cleanupEvery=${cleanupHours}h`,
  );

  let cleanupTicks = 0;
  const stop = await startActivityOutboxWorker(intervalMs, batchSize);

  const cleanupInterval = setInterval(async () => {
    cleanupTicks++;
    if (cleanupTicks % Math.max(1, Math.floor((cleanupHours * 3_600_000) / intervalMs)) !== 0) return;
    try {
      const removed = await cleanupActivityOutbox();
      log.info(`cleanup removed ${removed} processed rows`);
    } catch (err) {
      log.error("cleanup failed", err);
    }
  }, intervalMs);

  const shutdown = () => {
    log.info("shutting down activity-outbox worker");
    stop();
    clearInterval(cleanupInterval);
    prismaBase
      .$disconnect()
      .catch(() => {})
      .finally(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error("worker crashed", err);
  process.exit(1);
});
