import { Worker, type Job } from "bullmq";

import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import {
  duplicateBullConnection,
  getBullConnection,
} from "@/lib/queue-connection";
import {
  AUTOMATION_JOBS_QUEUE_NAME,
  addAutomationJobNow,
  getAutomationQueue,
  type AutomationJobPayload,
} from "@/lib/queue";
import {
  isAutomationFairnessEnabled,
  releaseAutomationSlot,
  sweepAutomationFairness,
} from "@/lib/automation-fairness";
import { withSystemContext } from "@/lib/webhook-context";
import { runAutomationInline } from "@/services/automation-executor";
import { startTimeoutSweeper } from "@/services/automation-context";

const log = getLogger("worker.automations");

/**
 * Worker BullMQ dedicado que consome a fila `automation-jobs`.
 *
 * Multi-tenant (cuidado importante):
 *   - Workers rodam fora de qualquer RequestContext HTTP/Next.js.
 *   - `prisma` (cliente scoped) exige RequestContext — usar fora dele
 *     lança "chamado fora de RequestContext" ou executa sem filtro de tenant.
 *   - Solução: resolver `organizationId` via `prismaBase` a partir do
 *     `automationId` do payload e embrulhar em `withSystemContext`.
 *
 * O payload histórico NÃO carrega `organizationId` (diferente de leads/ETL).
 * A lookup por automationId é a fonte da verdade do tenant — mesma abordagem
 * já usada em `automation-worker-inline.ts`.
 *
 * Concurrency: `AUTOMATION_WORKER_CONCURRENCY` (default 4; ≤ DB_POOL_MAX).
 * Rate limit opcional (proteção de campanhas em massa):
 *   `AUTOMATION_RATE_LIMIT_MAX` + `AUTOMATION_RATE_LIMIT_DURATION`.
 *   Sem essas vars, sem limiter (comportamento atual).
 */

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

async function processAutomationJob(job: Job<AutomationJobPayload>): Promise<void> {
  const { automationId, context } = job.data;
  const jobCtx = log.child({
    automationId,
    jobId: job.id,
    event: context.event,
    attempt: job.attemptsMade + 1,
  });

  // Justiça por org: o slot da org (admission control) é liberado apenas no
  // fim TERMINAL do job — sucesso ou falha sem retries restantes. Falha
  // retryável mantém o slot: o job continua de posse do BullMQ (delayed).
  const fairOrgId = job.data.organizationId;
  const releaseFairSlot = async (terminal: boolean) => {
    if (!terminal || !fairOrgId) return;
    await releaseAutomationSlot(fairOrgId, job.id, (p, jobId) =>
      addAutomationJobNow(p, jobId),
    );
  };
  const maxAttempts = Math.max(1, Number(job.opts.attempts ?? 1));

  try {
    const automation = await prismaBase.automation.findUnique({
      where: { id: automationId },
      select: { organizationId: true },
    });

    if (!automation) {
      jobCtx.warn("Automação não encontrada — descartando job");
      // Não re-throw: retries não vão recuperar um ID inexistente.
      await releaseFairSlot(true);
      return;
    }

    jobCtx.info(
      { organizationId: automation.organizationId },
      "Processando job de automação",
    );

    await withSystemContext(automation.organizationId, async () => {
      await runAutomationInline({ ...job.data, attemptsMade: job.attemptsMade });
    });
    await releaseFairSlot(true);
  } catch (err) {
    await releaseFairSlot(job.attemptsMade + 1 >= maxAttempts);
    throw err;
  }
}

export function startAutomationWorker() {
  const concurrency = envInt("AUTOMATION_WORKER_CONCURRENCY", 4);
  const connection = duplicateBullConnection();
  // Força inicialização do singleton de filas (produtores no mesmo processo,
  // ex.: transfer_automation → enqueueAutomationJob).
  getBullConnection();

  // Rate limiter opcional: útil quando a campanha WhatsApp em massa dispara
  // automações (event `campaign_trigger`) — cada job pode enviar mensagem Meta
  // e sem teto o worker estoura o rate limit da Cloud API.
  const rateLimitMax = envInt("AUTOMATION_RATE_LIMIT_MAX", 0);
  const limiter =
    rateLimitMax > 0
      ? {
          max: rateLimitMax,
          duration: envInt("AUTOMATION_RATE_LIMIT_DURATION", 1000),
        }
      : undefined;

  const worker = new Worker<AutomationJobPayload>(
    AUTOMATION_JOBS_QUEUE_NAME,
    processAutomationJob,
    { connection, concurrency, limiter },
  );

  // Sweeper da justiça por org: reconcilia os slots de inflight com o estado
  // real no BullMQ e re-pumpa backlogs (cura crash entre admit/release).
  // Roda INCONDICIONALMENTE: com fairness desligada (rollback) ele ainda
  // drena o backlog Redis residual do período ligado; sem backlog é no-op
  // (SMEMBERS vazio). Intervalo fixo de 15s.
  const sweep = () => {
    const queue = getAutomationQueue();
    if (!queue) return;
    void sweepAutomationFairness(queue, (p, jobId) =>
      addAutomationJobNow(p, jobId),
    ).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Sweep do admission control falhou",
      );
    });
  };
  sweep();
  const sweepTimer = setInterval(sweep, 15_000);
  sweepTimer.unref?.();
  log.info({ fairness: isAutomationFairnessEnabled() }, "automation fairness sweeper ativo (15s)");
  startTimeoutSweeper();

  worker.on("completed", (job) => {
    log.info(
      {
        automationId: job.data.automationId,
        jobId: job.id,
        event: job.data.context.event,
      },
      "Job concluído",
    );
  });

  worker.on("failed", (job, err) => {
    log.error(
      {
        automationId: job?.data.automationId,
        jobId: job?.id,
        event: job?.data.context.event,
        attempt: (job?.attemptsMade ?? 0) + 1,
        err: err?.message ?? String(err),
      },
      "Job falhou",
    );
  });

  worker.on("error", (err) => {
    log.error({ err: err?.message ?? String(err) }, "Worker error");
  });

  log.info(
    {
      concurrency,
      queue: AUTOMATION_JOBS_QUEUE_NAME,
      rateLimit: limiter ? `${limiter.max}/${limiter.duration}ms` : "off",
    },
    "automation-worker started",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Recebido sinal de shutdown — fechando worker");
    try {
      await worker.close();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Erro ao fechar worker",
      );
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return worker;
}

// Bootstrap quando executado diretamente (npm script ou node dist/.../automation-worker.js).
if (require.main === module) {
  startAutomationWorker();
}
