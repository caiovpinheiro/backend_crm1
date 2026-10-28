/**
 * Job diário de retenção do webchat v2 (contexto vivo + linha do tempo),
 * dentro do worker-meta-webhook — mesmo molde do `db-retention-sweeper`.
 *
 * A cada 15 min o processo tenta a trava do dia UTC no Redis
 * (`cache.tryClaim("webchat-retention:<data>")`, SET NX): só UMA instância
 * por dia roda `sweepWebchatRetention`. Worker fora do ar o dia todo = o dia
 * é pulado e o seguinte recolhe (o corte é por data, nada se perde). Falha
 * não solta a trava: o dia seguinte tenta de novo.
 *
 * Env: `WEBCHAT_RETENTION_WORKER=0` desliga (padrão ligado).
 */
import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";

import { sweepWebchatRetention, type WebchatRetentionRun } from "./retention";

const log = getLogger("webchat-retention-sweeper");

const TICK_MS = 15 * 60_000;
/** A trava vale mais que o resto do dia: ninguém roda duas vezes no mesmo dia. */
const CLAIM_TTL_SEC = 26 * 60 * 60;

export function isWebchatRetentionWorkerEnabled(): boolean {
  return (process.env.WEBCHAT_RETENTION_WORKER ?? "1").trim() !== "0";
}

/** Chave da trava: uma por dia UTC. */
export function webchatRetentionClaimKey(now: Date): string {
  return `webchat-retention:${now.toISOString().slice(0, 10)}`;
}

export type WebchatRetentionTickResult =
  | { ran: false; reason: "disabled" | "claimed-elsewhere" }
  | { ran: true; run: WebchatRetentionRun };

/**
 * Um tick (exportado para teste e para rodar à mão). Falha de um canal só é
 * logada; falha ao listar os canais sobe (o `start` loga).
 */
export async function runWebchatRetentionTick(
  now: Date = new Date(),
): Promise<WebchatRetentionTickResult> {
  if (!isWebchatRetentionWorkerEnabled()) return { ran: false, reason: "disabled" };
  if (!(await cache.tryClaim(webchatRetentionClaimKey(now), CLAIM_TTL_SEC))) {
    return { ran: false, reason: "claimed-elsewhere" };
  }
  const run = await sweepWebchatRetention({ now });
  const events = run.channels.reduce((n, c) => n + c.events, 0);
  const contexts = run.channels.reduce((n, c) => n + c.contexts, 0);
  log.info(
    { channels: run.channels.length, events, contexts, hitCap: run.channels.some((c) => c.hitCap) },
    `[webchat-retention] ${events} eventos e ${contexts} contextos apagados`,
  );
  return { ran: true, run };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Liga o tick no processo (idempotente). No-op com `WEBCHAT_RETENTION_WORKER=0`. */
export function startWebchatRetentionSweeper(): void {
  if (timer || !isWebchatRetentionWorkerEnabled()) return;
  const tick = () => {
    if (running) return;
    running = true;
    void runWebchatRetentionTick()
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[webchat-retention] rodada falhou",
        );
      })
      .finally(() => {
        running = false;
      });
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  log.info({ tickMs: TICK_MS }, "[webchat-retention] job diário ligado");
}

export function stopWebchatRetentionSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
