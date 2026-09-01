/**
 * Fila BullMQ `distribution-drain`.
 *
 * A API (`APP_MODE=api`) só enfileira "capacidade liberada" / cron / online.
 * O `worker-distribution` (e, na Phase A, o `worker-leads`) drena
 * `processPendingDistributionQueue` — tira o scan pesado do processo
 * HTTP do inbox.
 *
 * Arquivo separado de `lib/queue.ts` de propósito (meta-attach / outbound
 * têm PRs irmãos).
 */

import { Queue, type JobsOptions } from "bullmq";

import {
  getBullConnection,
  isRedisConfigured,
} from "@/lib/queue-connection";

export const DISTRIBUTION_DRAIN_QUEUE_NAME = "distribution-drain" as const;
export const DISTRIBUTION_DRAIN_JOB_NAME = "process-pending" as const;

export type DistributionDrainTrigger =
  | "new_item"
  | "agent_online"
  | "agent_eligible"
  | "capacity_released"
  | "manual"
  | "scheduled";

export type DistributionDrainPayload = {
  organizationId: string;
  trigger: DistributionDrainTrigger;
  userId?: string | null;
};

const globalForDrain = globalThis as unknown as {
  distributionDrainQueue?: Queue<DistributionDrainPayload>;
};

/** BullMQ rejeita `:` em custom jobId. Dedup por org+gatilho. */
export function distributionDrainJobId(
  orgId: string,
  trigger: string,
): string {
  return `dd-${orgId}-${trigger}`;
}

export function getDistributionDrainQueue(): Queue<DistributionDrainPayload> | null {
  if (!isRedisConfigured()) return null;
  if (!globalForDrain.distributionDrainQueue) {
    globalForDrain.distributionDrainQueue = new Queue<DistributionDrainPayload>(
      DISTRIBUTION_DRAIN_QUEUE_NAME,
      { connection: getBullConnection() },
    );
  }
  return globalForDrain.distributionDrainQueue;
}

/**
 * Enfileira drenagem no `worker-distribution` (e `worker-leads` na Phase A).
 *
 * - `added` / `exists`: caller NÃO deve rodar processPending in-process.
 * - `null`: Redis/fila indisponível — caller faz fallback síncrono.
 */
export async function enqueueDistributionDrain(
  payload: DistributionDrainPayload,
): Promise<"added" | "exists" | null> {
  const queue = getDistributionDrainQueue();
  if (!queue) return null;

  const attempts = readPositiveInt(
    process.env.DISTRIBUTION_DRAIN_MAX_ATTEMPTS,
    3,
  );
  const backoffDelay = readPositiveInt(
    process.env.DISTRIBUTION_DRAIN_BACKOFF_DELAY,
    2000,
  );
  const opts: JobsOptions = {
    jobId: distributionDrainJobId(payload.organizationId, payload.trigger),
    removeOnComplete: true,
    removeOnFail: { count: 200 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
  };

  try {
    await queue.add(DISTRIBUTION_DRAIN_JOB_NAME, payload, opts);
    return "added";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists|duplicat/i.test(msg)) return "exists";
    console.warn(
      "[queue] falha ao enfileirar distribution-drain:",
      msg,
    );
    return null;
  }
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
