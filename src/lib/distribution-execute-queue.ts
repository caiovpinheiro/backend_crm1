/**
 * Fila BullMQ `distribution-execute`.
 *
 * A API (`APP_MODE=api`) autentica, persiste o que for durável e enfileira.
 * O `worker-distribution` roda `executeDistribution` / redistribuição /
 * stuck-inbound. Espelha `distribution-drain-queue.ts`.
 */

import { Queue, QueueEvents, type Job, type JobsOptions } from "bullmq";

import {
  duplicateBullConnection,
  getBullConnection,
  isRedisConfigured,
} from "@/lib/queue-connection";
import type { StuckInboundOptions } from "@/services/ai/stuck-inbound-distribution";
import type {
  DistributionResult,
  DistributionTriggerSource,
} from "@/services/distribution/engine";
import type {
  RedistributeInput,
  RedistributeJobOutcome,
} from "@/services/distribution/redistribute";

import { allowInlineDistributionFallback } from "@/lib/distribution-drain-queue";

export const DISTRIBUTION_EXECUTE_QUEUE_NAME = "distribution-execute" as const;
export const DISTRIBUTION_EXECUTE_JOB_NAME = "execute" as const;
export const DISTRIBUTION_REDISTRIBUTE_JOB_NAME = "redistribute" as const;
export const DISTRIBUTION_STUCK_INBOUND_JOB_NAME = "stuck-inbound" as const;

export const DISTRIBUTION_STUCK_INBOUND_JOB_ID = "dsi-stuck-inbound" as const;

export type DistributionExecutePayload = {
  organizationId: string;
  triggerSource: DistributionTriggerSource;
  conversationId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  departmentId?: string | null;
  departmentIds?: string[] | null;
  reassign?: boolean;
  allowOrgWideFallback?: boolean;
  distributionType?: string | null;
  requestedByUserId?: string | null;
  correlationId?: string;
};

export type DistributionRedistributePayload = {
  organizationId: string;
  sourceUserId: string;
  mode: RedistributeInput["mode"];
  recipientUserIds?: string[];
  queueScope?: RedistributeInput["queueScope"];
  actor: RedistributeInput["actor"];
};

export type DistributionStuckInboundPayload = {
  organizationId?: string | null;
  stuckMs?: number;
  sinceMs?: number;
  limit?: number;
  apply?: boolean;
};

export type DistributionExecuteJobData =
  | DistributionExecutePayload
  | DistributionRedistributePayload
  | DistributionStuckInboundPayload;

const DEFAULT_EXECUTE_WAIT_MS = 12_000;
const DEFAULT_REDISTRIBUTE_WAIT_MS = 15_000;

const globalForExecute = globalThis as unknown as {
  distributionExecuteQueue?: Queue<DistributionExecuteJobData>;
  distributionExecuteEvents?: QueueEvents;
};

/** BullMQ rejeita `:` em custom jobId. */
export function distributionExecuteJobId(
  payload: Pick<
    DistributionExecutePayload,
    "organizationId" | "conversationId" | "dealId" | "contactId" | "triggerSource"
  >,
): string | undefined {
  const target =
    payload.conversationId || payload.dealId || payload.contactId || null;
  if (!target) return undefined;
  return `de-${payload.organizationId}-${target}-${payload.triggerSource}`;
}

export function distributionRedistributeJobId(
  orgId: string,
  sourceUserId: string,
  mode: string,
  queueScope: string,
): string {
  return `dr-${orgId}-${sourceUserId}-${mode}-${queueScope}`;
}

export function getDistributionExecuteQueue(): Queue<DistributionExecuteJobData> | null {
  if (!isRedisConfigured()) return null;
  if (!globalForExecute.distributionExecuteQueue) {
    globalForExecute.distributionExecuteQueue =
      new Queue<DistributionExecuteJobData>(DISTRIBUTION_EXECUTE_QUEUE_NAME, {
        connection: getBullConnection(),
      });
  }
  return globalForExecute.distributionExecuteQueue;
}

function getDistributionExecuteEvents(): QueueEvents | null {
  if (!isRedisConfigured()) return null;
  if (!globalForExecute.distributionExecuteEvents) {
    globalForExecute.distributionExecuteEvents = new QueueEvents(
      DISTRIBUTION_EXECUTE_QUEUE_NAME,
      { connection: duplicateBullConnection() },
    );
  }
  return globalForExecute.distributionExecuteEvents;
}

function jobOpts(
  jobId: string | undefined,
  priority?: number,
): JobsOptions {
  const attempts = readPositiveInt(
    process.env.DISTRIBUTION_EXECUTE_MAX_ATTEMPTS,
    3,
  );
  const backoffDelay = readPositiveInt(
    process.env.DISTRIBUTION_EXECUTE_BACKOFF_DELAY,
    2000,
  );
  return {
    ...(jobId ? { jobId } : {}),
    ...(priority != null ? { priority } : {}),
    removeOnComplete: true,
    removeOnFail: { count: 200 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
  };
}

/** BullMQ: menor número = maior prioridade. MANUAL do inbox passa na frente. */
function executePriority(payload: DistributionExecuteJobData): number | undefined {
  if (
    "triggerSource" in payload &&
    payload.triggerSource === "MANUAL"
  ) {
    return 1;
  }
  return undefined;
}

async function addOrReuse(
  name: string,
  payload: DistributionExecuteJobData,
  jobId: string | undefined,
): Promise<{ job: Job<DistributionExecuteJobData>; status: "added" | "exists" } | null> {
  const queue = getDistributionExecuteQueue();
  if (!queue) return null;
  const opts = jobOpts(jobId, executePriority(payload));

  try {
    const job = await queue.add(name, payload, opts);
    return { job, status: "added" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!jobId || !/already exists|duplicat/i.test(msg)) {
      console.warn("[queue] falha ao enfileirar distribution-execute:", msg);
      return null;
    }
    const existing = await queue.getJob(jobId);
    if (!existing) return null;
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => {});
      try {
        const job = await queue.add(name, payload, opts);
        return { job, status: "added" };
      } catch (retryErr) {
        const retryMsg =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(
          "[queue] falha ao reenfileirar distribution-execute:",
          retryMsg,
        );
        return null;
      }
    }
    return { job: existing, status: "exists" };
  }
}

async function waitForJob<T>(
  job: Job<DistributionExecuteJobData>,
  timeoutMs: number,
): Promise<{ kind: "result"; result: T } | { kind: "queued"; jobId: string }> {
  const events = getDistributionExecuteEvents();
  const jobId = String(job.id ?? "");
  if (!events || !jobId) {
    return { kind: "queued", jobId };
  }
  await events.waitUntilReady();
  try {
    const result = (await job.waitUntilFinished(events, timeoutMs)) as T;
    return { kind: "result", result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timed out|timeout/i.test(msg)) {
      return { kind: "queued", jobId };
    }
    throw err;
  }
}

export type EnqueueWaitResult<T> =
  | { kind: "result"; result: T }
  | { kind: "queued"; jobId: string }
  | { kind: "unavailable" };

/**
 * Enfileira `execute` e espera o worker (timeout → `queued`).
 * Sem Redis: `unavailable` — caller faz fallback inline só em test/dev.
 */
export async function enqueueAndWaitDistributionExecute(
  payload: DistributionExecutePayload,
  timeoutMs = readPositiveInt(
    process.env.DISTRIBUTION_EXECUTE_WAIT_MS,
    DEFAULT_EXECUTE_WAIT_MS,
  ),
): Promise<EnqueueWaitResult<DistributionResult>> {
  const added = await addOrReuse(
    DISTRIBUTION_EXECUTE_JOB_NAME,
    payload,
    distributionExecuteJobId(payload),
  );
  if (!added) return { kind: "unavailable" };
  return waitForJob<DistributionResult>(added.job, timeoutMs);
}

export async function enqueueAndWaitDistributionRedistribute(
  payload: DistributionRedistributePayload,
  timeoutMs = readPositiveInt(
    process.env.DISTRIBUTION_REDISTRIBUTE_WAIT_MS,
    DEFAULT_REDISTRIBUTE_WAIT_MS,
  ),
): Promise<EnqueueWaitResult<RedistributeJobOutcome>> {
  const added = await addOrReuse(
    DISTRIBUTION_REDISTRIBUTE_JOB_NAME,
    payload,
    distributionRedistributeJobId(
      payload.organizationId,
      payload.sourceUserId,
      payload.mode,
      payload.queueScope ?? "all",
    ),
  );
  if (!added) return { kind: "unavailable" };
  return waitForJob<RedistributeJobOutcome>(added.job, timeoutMs);
}

/** Cron / inactivity: fire-and-forget com jobId estável (anti double-run). */
export async function enqueueDistributionStuckInbound(
  payload: DistributionStuckInboundPayload = {},
): Promise<"added" | "exists" | null> {
  const added = await addOrReuse(
    DISTRIBUTION_STUCK_INBOUND_JOB_NAME,
    { apply: true, ...payload },
    DISTRIBUTION_STUCK_INBOUND_JOB_ID,
  );
  if (!added) return null;
  return added.status;
}

/**
 * Antes MANUAL rodava inline na API (medo de starvation atrás do drain).
 * Drain e execute são filas distintas; MANUAL agora vai pela fila com
 * `priority: 1`. Mantido só como flag de teste / feature-toggle legado.
 */
export function shouldRunManualExecuteInline(
  _triggerSource: DistributionTriggerSource,
): boolean {
  return false;
}

export async function runDistributionExecuteOrInline(
  payload: DistributionExecutePayload,
  runInline: () => Promise<DistributionResult>,
): Promise<EnqueueWaitResult<DistributionResult>> {
  const queued = await enqueueAndWaitDistributionExecute(payload);
  if (queued.kind !== "unavailable") return queued;
  if (allowInlineDistributionFallback()) {
    return { kind: "result", result: await runInline() };
  }
  return { kind: "unavailable" };
}

export async function runDistributionRedistributeOrInline(
  payload: DistributionRedistributePayload,
  runInline: () => Promise<RedistributeJobOutcome>,
): Promise<EnqueueWaitResult<RedistributeJobOutcome>> {
  const queued = await enqueueAndWaitDistributionRedistribute(payload);
  if (queued.kind !== "unavailable") return queued;
  if (allowInlineDistributionFallback()) {
    return { kind: "result", result: await runInline() };
  }
  return { kind: "unavailable" };
}

export function stuckInboundEnqueueOpts(
  opts: StuckInboundOptions,
): DistributionStuckInboundPayload {
  return {
    organizationId: opts.organizationId ?? null,
    stuckMs: opts.stuckMs,
    sinceMs: opts.sinceMs,
    limit: opts.limit,
    apply: true,
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
