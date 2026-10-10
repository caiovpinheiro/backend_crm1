/**
 * Worker de inatividade dos agentes de IA.
 *
 * A cada tick: aviso e encerramento por falta de resposta conforme a
 * configuração de cada agente (motor v2, "Começo e fim › Cliente sem
 * responder") e a rede de segurança de inbound parado (conversa com
 * responsável IA sem resposta há muito tempo vai para a distribuição).
 */

import { enqueueDistributionStuckInbound } from "@/lib/distribution-execute-queue";
import { scheduleBackgroundInterval, scheduleBackgroundTimeout } from "@/lib/background-timers";
import { getLogger } from "@/lib/logger";
import { STUCK_INBOUND_MS } from "@/services/ai/stuck-inbound-distribution";

const log = getLogger("ai-agent-inactivity-worker");

const INTERVAL_MS = Number(process.env.AI_AGENT_INACTIVITY_INTERVAL_MS) || 60_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

let started = false;

export function startAIAgentInactivityWorker() {
  if (started) return;
  if (process.env.AI_AGENT_INACTIVITY_WORKER === "0") {
    log.info("[ai-inactivity] worker desativado via env");
    return;
  }
  started = true;
  const tick = async () => {
    try {
      await tickOnce();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "[ai-inactivity] tick falhou");
    }
  };
  // Primeiro tick depois de 20s pra dar tempo do servidor subir.
  scheduleBackgroundTimeout(() => {
    void tick();
    scheduleBackgroundInterval(() => void tick(), INTERVAL_MS);
  }, 20_000);
  log.info({ tickMs: INTERVAL_MS }, "[ai-inactivity] worker iniciado");
}

export async function tickOnce(now: Date = new Date()): Promise<void> {
  await import("@/services/ai-v2/inactivity")
    .then(({ processIdleV2 }) => processIdleV2(now))
    .catch((err) =>
      log.warn({ err: err instanceof Error ? err.message : err }, "[ai-inactivity] v2 falhou"),
    );

  try {
    const queued = await enqueueDistributionStuckInbound({
      apply: true,
      stuckMs: envMs("AI_AGENT_STUCK_INBOUND_MS", STUCK_INBOUND_MS),
    });
    if (!queued) {
      log.warn("[ai-inactivity] stuck-inbound não enfileirado (Redis/fila down)");
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "[ai-inactivity] enqueue stuck-inbound falhou");
  }
}
