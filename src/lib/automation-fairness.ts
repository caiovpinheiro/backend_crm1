import { randomUUID } from "node:crypto";

import IORedis from "ioredis";

import { prismaBase } from "@/lib/prisma-base";
import type { AutomationJobPayload } from "@/lib/queue";

/**
 * Justiça multi-tenant da fila `automation-jobs` — admission control por org.
 *
 * Problema (stress sa221601): a fila BullMQ é FIFO global, então uma org que
 * dispara um blast de automações (ex.: `campaign_trigger` de 5 mil
 * destinatários) ocupa TODOS os slots do worker até drenar — razão de
 * justiça medida = 0 (orgs seguintes com 0 jobs processados por minutos,
 * incluindo automações de inbound, que são interativas).
 *
 * Desenho (análogo ao rodízio de campanha em `campaign-worker.ts`, mas com
 * backlog em Redis em vez de Postgres — jobs de automação não têm tabela):
 *
 *   - `automation:fair:backlog:{org}` — LIST Redis com os envelopes pendentes
 *     da org (RPUSH no enqueue, ordem FIFO por org preservada).
 *   - `automation:fair:inflight:{org}` — SET de jobIds admitidos no BullMQ
 *     (waiting/active/delayed). Tamanho máximo = crédito da org.
 *   - `automation:fair:orgs` — SET de orgs com backlog/inflight (varredura
 *     do sweeper).
 *
 * O enqueue empurra para o backlog da org e roda o "pump": admite no BullMQ
 * até `AUTOMATION_ORG_CREDIT` jobs daquela org. Cada conclusão terminal
 * (sucesso ou falha final) libera o slot e admite o próximo da MESMA org —
 * como cada org tem no máximo `crédito` jobs na fila global, o FIFO do
 * BullMQ passa a intercalar orgs em vez de drenar uma por vez.
 *
 * Segurança contra crash (janela LPOP→add do pump):
 *   - O pump faz PEEK (LRANGE) em vez de POP e confirma cada item com
 *     `LREM backlog 1 <envelope>` DEPOIS do `queue.add`. Crash entre add e
 *     LREM deixa o envelope no backlog; o re-pump re-adiciona com o MESMO
 *     jobId determinístico do envelope e o BullMQ deduplica (mesmo padrão
 *     do `enqueueMetaWebhookEvent`). Sem perda e sem duplicata.
 *   - `LREM` por valor (não `LTRIM`) porque dois pumps da mesma org podem
 *     correr em processos distintos; o pior caso é over-admission transitório
 *     limitado pelo crédito.
 *   - Sweeper no worker (15s) reconcilia o SET de inflight com o estado real
 *     dos jobs no BullMQ (`getJobState`) e re-pumpa orgs com backlog — cura
 *     slots vazados por crash entre admit e release.
 *
 * Rollback sem rebuild: `AUTOMATION_FAIRNESS=0` volta ao enqueue direto
 * (FIFO global) — jobs já no backlog Redis são drenados pelo sweeper do
 * worker enquanto ele rodar com fairness ligado; se for desligar em
 * produção com backlog, rode o sweep uma última vez antes.
 */

const BACKLOG_PREFIX = "automation:fair:backlog:";
const INFLIGHT_PREFIX = "automation:fair:inflight:";
const ORGS_KEY = "automation:fair:orgs";

/** Envelope no backlog: `j` = jobId determinístico (dedup BullMQ), `p` = payload. */
type Envelope = { j: string; p: AutomationJobPayload };

/** Assinatura do enqueue real no BullMQ (fornecida por `lib/queue`). */
export type AutomationAddFn = (
  payload: AutomationJobPayload,
  jobId: string,
) => Promise<unknown>;

const globalForFairness = globalThis as unknown as {
  automationFairRedis?: IORedis;
  automationOrgByAutomationId?: Map<string, string>;
};

function getRedis(): IORedis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!globalForFairness.automationFairRedis) {
    const client = new IORedis(url, { maxRetriesPerRequest: null });
    client.on("error", (err) => {
      console.warn("[automation-fair] redis error:", err.message);
    });
    globalForFairness.automationFairRedis = client;
  }
  return globalForFairness.automationFairRedis;
}

/** Ligado por default; AUTOMATION_FAIRNESS=0/false/off = enqueue direto (rollback). */
export function isAutomationFairnessEnabled(): boolean {
  const raw = (process.env.AUTOMATION_FAIRNESS ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Máximo de jobs de uma org admitidos no BullMQ por vez. Default =
 * AUTOMATION_WORKER_CONCURRENCY (4): preserva o throughput de uma org
 * sozinha e garante intercalação quando há 2+ orgs com backlog.
 */
export function getAutomationOrgCredit(): number {
  return envPositiveInt(
    "AUTOMATION_ORG_CREDIT",
    envPositiveInt("AUTOMATION_WORKER_CONCURRENCY", 4),
  );
}

/**
 * Resolve o tenant da automação com cache por processo (automação não muda
 * de org — mesmo padrão do `resolveCampaignOrgId` do campaign-worker).
 * Miss não é cacheado: a automação pode ter sido criada depois do enqueue.
 */
async function resolveAutomationOrgId(automationId: string): Promise<string | null> {
  const cache = (globalForFairness.automationOrgByAutomationId ??= new Map());
  const hit = cache.get(automationId);
  if (hit) return hit;
  const row = await prismaBase.automation.findUnique({
    where: { id: automationId },
    select: { organizationId: true },
  });
  const orgId = row?.organizationId ?? null;
  if (orgId) cache.set(automationId, orgId);
  return orgId;
}

/**
 * PEEK dos próximos itens admissíveis da org: até `crédito - SCARD(inflight)`
 * envelopes do head do backlog. NÃO remove — a confirmação é por LREM após
 * o add (ver doc do módulo).
 */
const PEEK_ADMISSIBLE_SCRIPT = `
local cur = redis.call("SCARD", KEYS[2])
local room = tonumber(ARGV[1]) - cur
if room <= 0 then return {} end
local n = math.min(room, redis.call("LLEN", KEYS[1]))
if n <= 0 then return {} end
return redis.call("LRANGE", KEYS[1], 0, n - 1)
`;

/**
 * Admite no BullMQ os próximos jobs da org respeitando o crédito.
 * Retorna quantos foram admitidos. Erro no `add` interrompe o pump — os
 * envelopes não confirmados ficam no backlog e o próximo gatilho
 * (enqueue/release/sweeper) re-tenta.
 */
async function pumpOrg(orgId: string, add: AutomationAddFn): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  const credit = getAutomationOrgCredit();
  const items = (await r.eval(
    PEEK_ADMISSIBLE_SCRIPT,
    2,
    BACKLOG_PREFIX + orgId,
    INFLIGHT_PREFIX + orgId,
    String(credit),
  )) as string[];

  let admitted = 0;
  for (const raw of items) {
    let env: Envelope | null = null;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      env = null;
    }
    if (!env || typeof env.j !== "string" || !env.p) {
      // Envelope corrompido — remove do backlog para não travar a org.
      await r.lrem(BACKLOG_PREFIX + orgId, 1, raw).catch(() => {});
      continue;
    }
    try {
      await add(env.p, env.j);
    } catch (err) {
      console.warn(
        `[automation-fair] pump org=${orgId}: queue.add falhou (${err instanceof Error ? err.message : err}) — ${items.length - admitted} item(ns) seguem no backlog`,
      );
      break;
    }
    await r.sadd(INFLIGHT_PREFIX + orgId, env.j).catch(() => {});
    await r.lrem(BACKLOG_PREFIX + orgId, 1, raw).catch(() => {});
    admitted += 1;
  }
  return admitted;
}

/**
 * Caminho justo do `enqueueAutomationJob` (modo external). Retorna:
 *   - "fair"        → payload entrou no backlog da org (e pump rodou);
 *   - "fallback"    → org não resolvida — caller deve enfileirar direto
 *                     (comportamento histórico);
 *   - "unavailable" → Redis indisponível — caller decide (hoje: throw).
 */
export async function enqueueAutomationJobFair(
  payload: AutomationJobPayload,
  add: AutomationAddFn,
): Promise<"fair" | "fallback" | "unavailable"> {
  const r = getRedis();
  if (!r) return "unavailable";

  const orgId =
    payload.organizationId ??
    (await resolveAutomationOrgId(payload.automationId).catch(() => null));
  if (!orgId) return "fallback";

  const withOrg: AutomationJobPayload = { ...payload, organizationId: orgId };
  const env: Envelope = { j: `af_${randomUUID()}`, p: withOrg };
  await r.rpush(BACKLOG_PREFIX + orgId, JSON.stringify(env));
  await r.sadd(ORGS_KEY, orgId);
  await pumpOrg(orgId, add);
  return "fair";
}

/**
 * Libera o slot da org ao fim terminal do job (sucesso ou falha sem mais
 * retries) e admite o próximo do backlog. Nunca lança — falha aqui não
 * pode derrubar o job; o sweeper reconcilia em até 15s.
 */
export async function releaseAutomationSlot(
  orgId: string,
  jobId: string | undefined,
  add: AutomationAddFn,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (jobId) await r.srem(INFLIGHT_PREFIX + orgId, jobId);
    await pumpOrg(orgId, add);
  } catch (err) {
    console.warn(
      `[automation-fair] release org=${orgId} falhou (sweeper reconcilia):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Interface mínima do BullMQ Queue usada pelo sweeper. */
export type AutomationQueuePeek = {
  getJobState(jobId: string): Promise<string | undefined>;
};

/**
 * Reconciliação periódica (rodar no worker a cada ~15s):
 *   1. Remove do inflight os jobIds que não estão mais na fila
 *      (completed/removidos, failed terminais, desconhecidos) — cura slots
 *      vazados por crash entre admit e release.
 *   2. Re-pumpa orgs com backlog (cobre pump interrompido no meio).
 *   3. Poda orgs sem backlog nem inflight do conjunto varrido.
 */
export async function sweepAutomationFairness(
  queue: AutomationQueuePeek,
  add: AutomationAddFn,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const orgs = await r.smembers(ORGS_KEY);
  if (orgs.length === 0) return;

  let pumped = 0;
  for (const orgId of orgs) {
    try {
      const members = await r.smembers(INFLIGHT_PREFIX + orgId);
      for (const jobId of members) {
        const state = await queue.getJobState(jobId).catch(() => undefined);
        if (
          state === undefined ||
          state === "unknown" ||
          state === "completed" ||
          state === "failed"
        ) {
          await r.srem(INFLIGHT_PREFIX + orgId, jobId);
        }
      }
      pumped += await pumpOrg(orgId, add);
      const [backlogLen, inflight] = await Promise.all([
        r.llen(BACKLOG_PREFIX + orgId),
        r.scard(INFLIGHT_PREFIX + orgId),
      ]);
      if (backlogLen === 0 && inflight === 0) {
        await r.srem(ORGS_KEY, orgId);
        await r.del(INFLIGHT_PREFIX + orgId);
      }
    } catch (err) {
      console.warn(
        `[automation-fair] sweep org=${orgId} falhou:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (pumped > 0) {
    console.info(`[automation-fair] sweep admitiu ${pumped} job(s) de backlog`);
  }
}
