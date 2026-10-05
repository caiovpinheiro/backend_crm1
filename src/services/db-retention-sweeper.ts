/**
 * Job diário de retenção, dentro do worker-meta-webhook (C4 da auditoria de
 * banco, 05/10).
 *
 * `meta_webhook_events` chegou a 3,7 M de linhas sem limpeza: o serviço de
 * retenção (`db-retention.ts`) e a rota de cron existiam, mas nada os
 * agendava. Este tick roda no worker que já grava/lê a tabela.
 *
 * Como funciona
 * ─────────────
 * - A cada 10 min o processo olha o relógio. Dentro da janela da madrugada
 *   (`DB_RETENTION_WORKER_HOUR_UTC`, default 6 = 03:00 em Brasília, por
 *   `WINDOW_HOURS` horas) tenta a trava do dia no Redis
 *   (`cache.tryClaim("db-retention:<data UTC>")`, SET NX). Só UMA
 *   instância por dia ganha — com 2 réplicas do worker, uma roda e a outra
 *   não faz nada. Worker fora do ar na janela = aquele dia é pulado; o
 *   seguinte recolhe o atraso (o corte é por data, nada se perde).
 * - Quem ganhou chama `runDbRetention` só para as tabelas de
 *   `DB_RETENTION_WORKER_TARGETS` (default `meta_webhook_events`), sem o
 *   `count(*)` prévio, com teto de lotes e pausa entre eles.
 * - Loga o total apagado por tabela.
 *
 * O que NÃO apaga: evento não processado (`processed = false`), qualquer
 * coisa mais nova que a janela (`DB_RETENTION_META_WEBHOOK_DAYS`, default
 * 30 dias), e nada se faltar um dos índices de que o DELETE depende.
 *
 * Env
 * ───
 *   DB_RETENTION_WORKER             "0" desliga o job (default ligado)
 *   DB_RETENTION_WORKER_HOUR_UTC    hora UTC em que a janela abre (6)
 *   DB_RETENTION_WORKER_TARGETS     tabelas, separadas por vírgula
 *   DB_RETENTION_WORKER_MAX_BATCHES lotes de 5 mil por tabela por noite (60
 *                                   = 300 mil linhas; a tabela ganha ~120
 *                                   mil por dia)
 *   DB_RETENTION_WORKER_PAUSE_MS    pausa entre lotes (250)
 */
import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";
import { runDbRetention, type RetentionRun } from "@/services/db-retention";

const log = getLogger("db-retention-sweeper");

const TICK_MS = 10 * 60_000;
const WINDOW_HOURS = 3;
/** A trava dura mais que a janela: ninguém roda duas vezes no mesmo dia. */
const CLAIM_TTL_SEC = 20 * 60 * 60;
const DEFAULT_TARGETS = ["meta_webhook_events"];

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function isDbRetentionWorkerEnabled(): boolean {
  return (process.env.DB_RETENTION_WORKER ?? "1").trim() !== "0";
}

function workerTargets(): string[] {
  const raw = process.env.DB_RETENTION_WORKER_TARGETS?.trim();
  if (!raw) return DEFAULT_TARGETS;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_TARGETS;
}

/** `true` dentro da janela diária (hora UTC configurada + `WINDOW_HOURS`). */
export function isInsideRetentionWindow(now: Date): boolean {
  const opensAt = envInt("DB_RETENTION_WORKER_HOUR_UTC", 6, 0, 23);
  const hoursSinceOpen = (now.getUTCHours() - opensAt + 24) % 24;
  return hoursSinceOpen < WINDOW_HOURS;
}

/** Chave da trava: uma por dia UTC em que a janela ABRIU. */
export function retentionClaimKey(now: Date): string {
  const opensAt = envInt("DB_RETENTION_WORKER_HOUR_UTC", 6, 0, 23);
  // Janela que cruza a meia-noite UTC pertence ao dia em que abriu.
  const opened = new Date(now.getTime());
  if (now.getUTCHours() < opensAt) opened.setUTCDate(opened.getUTCDate() - 1);
  return `db-retention:${opened.toISOString().slice(0, 10)}`;
}

export type RetentionTickResult =
  | { ran: false; reason: "disabled" | "outside-window" | "claimed-elsewhere" }
  | { ran: true; run: RetentionRun };

/**
 * Um tick. Exportado para teste e para rodar à mão; `now` injetável.
 * Nunca lança: falha é logada e o dia fica para a próxima janela (a trava
 * já foi gasta — de propósito, para uma falha não virar laço de tentativas
 * em cima de um banco que já está sofrendo).
 */
export async function runDbRetentionTick(now: Date = new Date()): Promise<RetentionTickResult> {
  if (!isDbRetentionWorkerEnabled()) return { ran: false, reason: "disabled" };
  if (!isInsideRetentionWindow(now)) return { ran: false, reason: "outside-window" };
  if (!(await cache.tryClaim(retentionClaimKey(now), CLAIM_TTL_SEC))) {
    return { ran: false, reason: "claimed-elsewhere" };
  }

  const startedAt = Date.now();
  const run = await runDbRetention({
    apply: true,
    only: workerTargets(),
    count: false,
    maxBatches: envInt("DB_RETENTION_WORKER_MAX_BATCHES", 60, 1, 400),
    pauseMs: envInt("DB_RETENTION_WORKER_PAUSE_MS", 250, 0, 10_000),
  });
  for (const t of run.targets) {
    const payload = {
      table: t.key,
      cutoff: t.cutoff,
      deleted: t.deleted,
      batches: t.batches,
      hitCap: t.hitCap,
      ms: Date.now() - startedAt,
    };
    if (t.skipped) {
      log.warn({ ...payload, skipped: t.skipped }, "[db-retention] tabela pulada");
    } else {
      log.info(payload, `[db-retention] ${t.key}: ${t.deleted} linhas apagadas`);
    }
  }
  return { ran: true, run };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Liga o tick no processo (idempotente). No-op com `DB_RETENTION_WORKER=0`. */
export function startDbRetentionSweeper(): void {
  if (timer || !isDbRetentionWorkerEnabled()) return;
  const tick = () => {
    if (running) return;
    running = true;
    void runDbRetentionTick()
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[db-retention] rodada falhou",
        );
      })
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  log.info({ tickMs: TICK_MS, targets: workerTargets() }, "[db-retention] job diário ligado");
}

export function stopDbRetentionSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
