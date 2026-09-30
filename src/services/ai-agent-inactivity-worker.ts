/**
 * AI Agent Inactivity Worker.
 *
 * 1) Cliente sem responder: aviso e encerramento pela config de cada
 *    agente ("Começo e fim › Cliente sem responder").
 *
 * 2) Distribuição de segurança: cliente esperando resposta da IA há tempo
 *    demais vai para a fila humana. Override: `AI_AGENT_STUCK_INBOUND_MS`.
 *
 * Opt-out do worker inteiro: `AI_AGENT_INACTIVITY_WORKER=0`.
 */


import { enqueueDistributionStuckInbound } from "@/lib/distribution-execute-queue";
import { STUCK_INBOUND_MS } from "@/services/ai/stuck-inbound-distribution";

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
    console.info("[ai-inactivity] worker desativado via env");
    return;
  }
  started = true;

  const tick = async () => {
    try {
      await tickOnce();
    } catch (err) {
      console.warn(
        "[ai-inactivity] tick falhou:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  // Primeiro tick depois de 20s pra dar tempo do servidor subir.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS);
  }, 20_000);

  console.info(`[ai-inactivity] worker iniciado (tick=${INTERVAL_MS}ms)`);
}

export async function tickOnce(now: Date = new Date()) {
  await import("@/services/ai-v2/inactivity")
    .then(({ processIdleV2 }) => processIdleV2(now))
    .catch((err) =>
      console.warn("[ai-inactivity] v2 falhou:", err instanceof Error ? err.message : err),
    );

  // Cliente esperando resposta da IA há tempo demais → mesmo job do cron
  // (`dsi-stuck-inbound`) no worker-distribution. Dedup evita SQL duplo.
  try {
    const queued = await enqueueDistributionStuckInbound({
      apply: true,
      stuckMs: envMs("AI_AGENT_STUCK_INBOUND_MS", STUCK_INBOUND_MS),
    });
    if (!queued) {
      console.warn(
        "[ai-inactivity] stuck-inbound não enfileirado (Redis/fila down)",
      );
    }
  } catch (err) {
    console.warn(
      "[ai-inactivity] enqueue stuck-inbound falhou:",
      err instanceof Error ? err.message : err,
    );
  }
}
