/**
 * Snapshot diário do estoque OPEN por etapa, dentro do worker-meta-webhook.
 *
 * `deal_stage_daily_snapshots` alimenta a "Evolução diária" do Painel. A rota
 * `GET /api/cron/deal-stage-snapshot` existia, mas dependia de um Scheduled
 * Service externo que nunca foi criado em produção: o histórico só ganhava o
 * ponto do dia quando alguém abria a evolução (`ensureTodayDealStageSnapshot`,
 * só da própria org). Este tick agenda a gravação no worker, como o
 * `db-retention-sweeper`. A rota de cron continua funcionando.
 *
 * Como funciona
 * ─────────────
 * - A cada 5 min o processo olha o relógio de São Paulo. A partir das 03:05
 *   (hora civil de SP) tenta a trava do dia no Redis
 *   (`cache.tryClaim("deal-stage-snapshot:<data SP>")`, SET NX). Só UMA
 *   instância por dia ganha — com 2 réplicas do worker, uma grava e a outra
 *   não faz nada. Worker fora do ar às 03:05 = grava no primeiro tick depois
 *   que voltar, no mesmo dia.
 * - Quem ganhou chama `recordDealStageSnapshots` (todas as orgs ativas).
 *   Idempotente: a gravação é `ON CONFLICT (organizationId, stageId, date)
 *   DO UPDATE` — rodar duas vezes no dia atualiza a mesma linha, não duplica.
 * - Falha solta a trava: o próximo tick (5 min) tenta de novo.
 *
 * Env
 * ───
 *   DEAL_STAGE_SNAPSHOT_WORKER   "0" desliga o job (default ligado)
 */
import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";
import { dayKeyFromDate, zonedParts } from "@/services/painel-period";
import { recordDealStageSnapshots } from "@/services/painel-snapshots";

const log = getLogger("deal-stage-snapshot-sweeper");

const TICK_MS = 5 * 60_000;
/** Hora civil de São Paulo a partir da qual o snapshot do dia é gravado. */
const RUN_AT_MINUTES = 3 * 60 + 5;
/** A trava dura mais que o resto do dia: ninguém grava duas vezes no mesmo dia. */
const CLAIM_TTL_SEC = 26 * 60 * 60;

export function isDealStageSnapshotWorkerEnabled(): boolean {
  return (process.env.DEAL_STAGE_SNAPSHOT_WORKER ?? "1").trim() !== "0";
}

/** `true` a partir das 03:05 de São Paulo até o fim do dia civil. */
export function isDealStageSnapshotDue(now: Date): boolean {
  const p = zonedParts(now);
  return p.hour * 60 + p.minute >= RUN_AT_MINUTES;
}

/** Chave da trava: uma por dia civil de São Paulo. */
export function dealStageSnapshotClaimKey(now: Date): string {
  return `deal-stage-snapshot:${dayKeyFromDate(now)}`;
}

export type DealStageSnapshotTickResult =
  | { ran: false; reason: "disabled" | "not-yet" | "claimed-elsewhere" }
  | { ran: true; orgs: number; rows: number; pruned: number; date: string };

/**
 * Um tick. Exportado para teste e para rodar à mão; `now` injetável.
 * Falha solta a trava e relança (o loop loga).
 */
export async function runDealStageSnapshotTick(
  now: Date = new Date(),
): Promise<DealStageSnapshotTickResult> {
  if (!isDealStageSnapshotWorkerEnabled()) return { ran: false, reason: "disabled" };
  if (!isDealStageSnapshotDue(now)) return { ran: false, reason: "not-yet" };
  const key = dealStageSnapshotClaimKey(now);
  if (!(await cache.tryClaim(key, CLAIM_TTL_SEC))) {
    return { ran: false, reason: "claimed-elsewhere" };
  }

  const startedAt = Date.now();
  try {
    const result = await recordDealStageSnapshots(now);
    log.info(
      { ...result, ms: Date.now() - startedAt },
      `[deal-stage-snapshot] ${result.date}: ${result.rows} linhas em ${result.orgs} orgs`,
    );
    return { ran: true, ...result };
  } catch (err) {
    await cache.del(key);
    throw err;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Liga o tick no processo (idempotente). No-op com `DEAL_STAGE_SNAPSHOT_WORKER=0`. */
export function startDealStageSnapshotSweeper(): void {
  if (timer || !isDealStageSnapshotWorkerEnabled()) return;
  const tick = () => {
    if (running) return;
    running = true;
    void runDealStageSnapshotTick()
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[deal-stage-snapshot] rodada falhou",
        );
      })
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  log.info({ tickMs: TICK_MS, at: "03:05 America/Sao_Paulo" }, "[deal-stage-snapshot] job diário ligado");
}

export function stopDealStageSnapshotSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
