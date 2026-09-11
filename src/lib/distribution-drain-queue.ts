/**
 * Fila BullMQ `distribution-drain`.
 *
 * A API (`APP_MODE=api`) só enfileira gatilhos de evento / `hours_open`.
 * O `worker-distribution` drena `processPendingDistributionQueue` —
 * tira o scan pesado do processo HTTP do inbox. Cron `/api/cron/distribution-pending`
 * não enfileira mais.
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
  | "hours_open"
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
 * Enfileira drenagem no `worker-distribution`.
 *
 * - `added` / `exists`: caller NÃO deve rodar processPending in-process.
 * - `null`: Redis/fila indisponível — fallback síncrono só em test/dev.
 */
export function isFreshDrainEnqueue(
  result: "added" | "exists" | null,
): boolean {
  return result === "added";
}

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

/** BullMQ delay é int32; 8 dias de lookahead cabem folgado. */
const BULLMQ_MAX_DELAY_MS = 2_147_483_647;

/**
 * Um job atrasado por org no próximo expediente. Substitui o delayed
 * anterior (`dd-{org}-hours_open`) para o horário novo valer.
 */
export async function enqueueHoursOpenDrain(
  organizationId: string,
  delayMs: number,
): Promise<"added" | "exists" | null> {
  const delay = Math.min(Math.max(0, Math.floor(delayMs)), BULLMQ_MAX_DELAY_MS);
  const queue = getDistributionDrainQueue();
  if (!queue) return null;

  const jobId = distributionDrainJobId(organizationId, "hours_open");
  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active") return "exists";
      if (state !== "unknown") {
        await existing.remove();
      }
    }
  } catch (e) {
    console.warn("[queue] falha ao substituir hours_open delayed:", e);
  }

  const attempts = readPositiveInt(
    process.env.DISTRIBUTION_DRAIN_MAX_ATTEMPTS,
    3,
  );
  const backoffDelay = readPositiveInt(
    process.env.DISTRIBUTION_DRAIN_BACKOFF_DELAY,
    2000,
  );
  const opts: JobsOptions = {
    jobId,
    delay,
    removeOnComplete: true,
    removeOnFail: { count: 200 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
  };

  try {
    await queue.add(
      DISTRIBUTION_DRAIN_JOB_NAME,
      { organizationId, trigger: "hours_open", userId: null },
      opts,
    );
    return "added";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists|duplicat/i.test(msg)) return "exists";
    console.warn("[queue] falha ao enfileirar hours_open:", msg);
    return null;
  }
}

export async function cancelHoursOpenDrain(
  organizationId: string,
): Promise<void> {
  const queue = getDistributionDrainQueue();
  if (!queue) return;
  const jobId = distributionDrainJobId(organizationId, "hours_open");
  try {
    const existing = await queue.getJob(jobId);
    if (!existing) return;
    const state = await existing.getState();
    if (state === "active") return;
    await existing.remove();
  } catch (e) {
    console.warn("[queue] falha ao cancelar hours_open delayed:", e);
  }
}

/**
 * Fallback síncrono do motor/drain no processo da API.
 * Produção (`APP_MODE=api`) nunca roda o scan/engine in-process.
 * Vitest e dev local sem Redis continuam inline.
 */
export function allowInlineDistributionFallback(): boolean {
  const env = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  if (env === "test" || env === "development") return true;
  return false;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
