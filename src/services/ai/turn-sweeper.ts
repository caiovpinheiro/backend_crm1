/**
 * Sweeper do Turn Manager — o que garante que nenhum turno fica órfão.
 *
 * Por que um LOOP DE WORKER + ROTA DE CRON e não BullMQ com `delay`:
 *
 *   - BullMQ delayed job + `jobId` determinístico por turno resolve a
 *     latência, mas não resolve o problema: a janela de debounce RESETA a
 *     cada bolha. Cada mensagem exigiria remove + re-add do job atrasado
 *     (BullMQ ignora `add` com jobId já existente, então "atualizar o
 *     delay" não é uma operação — é um remove/add com corrida no meio).
 *     E job atrasado que se perde (FLUSHDB, eviction, Redis novo) some
 *     sem deixar rastro — exatamente a falha do debounce antigo, só que
 *     em Redis em vez de em memória.
 *   - Uma fila nova também exigiria worker novo + `APP_MODE` novo +
 *     mudança na topologia de deploy. Custo alto para a Fase 1.
 *   - O loop lê o BANCO. Turno pendente é uma linha com status e
 *     timestamps: qualquer processo, a qualquer momento, reconstrói o
 *     trabalho pendente com um SELECT. Restart, deploy, crash, réplica
 *     nova ou Redis zerado não mudam nada.
 *
 * O tick roda em todo processo que ingere inbound (API, worker Meta,
 * worker Baileys) — o claim atômico torna a concorrência inofensiva. A
 * rota `/api/cron/ai-turns-sweep` é a rede de segurança externa: se TODOS
 * os ticks estiverem mortos, o cron ainda drena a fila.
 */

import { prismaBase } from "@/lib/prisma-base";
import {
  claimTurn,
  isTurnManagerEnabled,
  isTurnDue,
  promoteTurnToReady,
  runTurn,
  turnMaxAttempts,
  turnStaleMs,
  TURN_DEBOUNCE_FLOOR_MS,
} from "@/services/ai/turn-manager";

export type SweepResult = {
  promoted: number;
  dispatched: number;
  reclaimed: number;
  failed: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function logSweep(event: string, payload: Record<string, unknown>) {
  console.info(
    "[ai-turn-sweep]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

/**
 * Um tick: promove turnos vencidos, despacha READY e recupera PROCESSING
 * travado. Cross-org (por isso `prismaBase` — o sweeper roda fora de
 * RequestContext; `runTurn` reentra em `withSystemContext` por turno).
 */
export async function sweepConversationTurns(
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<SweepResult> {
  const limit = opts.limit ?? envInt("AI_TURN_SWEEP_BATCH", 50);
  const result: SweepResult = {
    promoted: 0,
    dispatched: 0,
    reclaimed: 0,
    failed: 0,
  };

  // ── 1. Stale reclaim ──────────────────────────────────────
  // PROCESSING mais velho que o teto = worker morreu no meio (deploy,
  // OOM, SIGKILL). Volta para READY com attempts++, ou vira FAILED
  // depois do teto de tentativas — sem isso um turno venenoso ficaria
  // sendo reprocessado para sempre.
  const staleCutoff = new Date(Date.now() - turnStaleMs());
  const stale = await prismaBase.conversationTurn.findMany({
    where: { status: "PROCESSING", claimedAt: { lt: staleCutoff } },
    orderBy: { claimedAt: "asc" },
    take: limit,
  });
  for (const turn of stale) {
    if (opts.dryRun) continue;
    const attempts = turn.attempts + 1;
    if (attempts >= turnMaxAttempts()) {
      const res = await prismaBase.conversationTurn.updateMany({
        where: { id: turn.id, status: "PROCESSING", claimedAt: turn.claimedAt },
        data: {
          status: "FAILED",
          attempts,
          lastError: `stale reclaim: teto de ${turnMaxAttempts()} tentativas (claimedBy=${turn.claimedBy ?? "?"})`,
          completedAt: new Date(),
          openKey: null,
        },
      });
      if (res.count === 1) {
        result.failed += 1;
        logSweep("stale_failed", { turnId: turn.id, attempts });
      }
      continue;
    }
    const res = await prismaBase.conversationTurn.updateMany({
      // `claimedAt` no where evita roubar um turno que o dono legítimo
      // acabou de renovar entre o SELECT e o UPDATE.
      where: { id: turn.id, status: "PROCESSING", claimedAt: turn.claimedAt },
      data: {
        status: "READY",
        attempts,
        claimedBy: null,
        claimedAt: null,
        openKey: turn.conversationId,
        lastError: `stale reclaim: claim de ${turn.claimedBy ?? "?"} expirou`,
      },
    });
    if (res.count === 1) {
      result.reclaimed += 1;
      logSweep("stale_reclaimed", { turnId: turn.id, attempts });
    }
  }

  // ── 2. Promoção de turnos vencidos ────────────────────────
  // Candidatos: turnos acumulando com pelo menos o PISO da janela de
  // idade. `firstMessageAt` (e não `lastMessageAt`) porque em fluxo
  // contínuo o cliente não para de digitar e `lastMessageAt` nunca
  // envelhece — quem libera esse caso é o MAX_WAIT, que conta da
  // primeira mensagem. Como maxWaitMs >= debounceMs >= piso, esse filtro
  // é um superconjunto seguro dos dois critérios.
  //
  // A decisão final (`isTurnDue`) usa as janelas CONGELADAS na linha —
  // zero lookup de org setting no sweeper.
  const floorCutoff = new Date(Date.now() - TURN_DEBOUNCE_FLOOR_MS);
  const open = await prismaBase.conversationTurn.findMany({
    where: {
      status: { in: ["RECEIVING", "STABILIZING"] },
      firstMessageAt: { lte: floorCutoff },
    },
    orderBy: { firstMessageAt: "asc" },
    take: limit,
  });
  for (const turn of open) {
    if (!isTurnDue(turn)) continue;
    if (opts.dryRun) {
      result.promoted += 1;
      continue;
    }
    const promoted = await promoteTurnToReady(turn.id, turn.organizationId);
    if (promoted) result.promoted += 1;
  }

  // ── 3. Dispatch dos READY ─────────────────────────────────
  // Inclui os turnos promovidos acima E os que ficaram READY de um
  // processo que morreu antes de claimar (recuperação de restart).
  const ready = await prismaBase.conversationTurn.findMany({
    where: { status: "READY" },
    orderBy: { readyAt: "asc" },
    take: limit,
  });
  for (const turn of ready) {
    if (opts.dryRun) {
      result.dispatched += 1;
      continue;
    }
    const claimed = await claimTurn(turn.id, turn.organizationId);
    if (!claimed) continue;
    result.dispatched += 1;
    await runTurn(claimed);
  }

  if (
    result.promoted ||
    result.dispatched ||
    result.reclaimed ||
    result.failed
  ) {
    logSweep("tick", { ...result, dryRun: Boolean(opts.dryRun) });
  }
  return result;
}

// ── Loop ────────────────────────────────────────────────────

let sweeperTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Sobe o tick no processo atual. Idempotente — pode ser chamado do boot
 * de vários módulos sem risco de dois loops.
 */
export function startAiTurnSweeper(): void {
  if (sweeperTimer) return;
  if (!isTurnManagerEnabled()) return;
  if ((process.env.AI_TURN_SWEEPER ?? "1").trim() === "0") return;

  const intervalMs = envInt("AI_TURN_SWEEP_INTERVAL_MS", 1000);
  const tick = () => {
    // Sem sobreposição: um tick lento (LLM no meio) não empilha ticks.
    if (sweeping) return;
    sweeping = true;
    void sweepConversationTurns()
      .catch((err) => {
        console.error("[ai-turn-sweep] tick falhou", {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  };

  sweeperTimer = setInterval(tick, intervalMs);
  sweeperTimer.unref?.();
  logSweep("started", { intervalMs });
}

export function stopAiTurnSweeper(): void {
  if (!sweeperTimer) return;
  clearInterval(sweeperTimer);
  sweeperTimer = null;
}
