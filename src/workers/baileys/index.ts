import { prisma } from "@/lib/prisma";
import { startAiTurnSweeper, stopAiTurnSweeper } from "@/services/ai/turn-sweeper";
import { startListenSweeper, stopListenSweeper } from "@/services/ai-v2/listen";
import { installGracefulShutdown } from "@/workers/graceful-shutdown";
import { BaileysManager } from "./baileys-manager";
import { startOutboundConsumer } from "./outbound-consumer";
import { startControlConsumer } from "./control-consumer";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys");

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const manager = new BaileysManager();

const outboundWorker = startOutboundConsumer(manager, redisUrl);
const controlWorker = startControlConsumer(manager, redisUrl);

async function startup() {
  log.info("[baileys-worker] Iniciando...");
  // Turn Manager (AI_TURN_MANAGER=1): este processo ingere o inbound
  // Baileys, então o turno nasce aqui e precisa de quem o promova.
  // No-op com a flag desligada.
  startAiTurnSweeper();
  startListenSweeper();
  await manager.startAll();
  log.info("[baileys-worker] Pronto — aguardando mensagens e comandos");
}

// SIGTERM com teto de 25 s (antes: sem teto, e um passo que lançasse
// impedia os seguintes). Filas fecham antes das sessões: o envio em curso
// termina com o socket ainda aberto.
installGracefulShutdown({
  name: "worker-baileys",
  log,
  steps: [
    {
      name: "sweepers",
      run: () => {
        stopAiTurnSweeper();
        stopListenSweeper();
      },
    },
    {
      name: "bullmq",
      run: () => Promise.all([outboundWorker.close(), controlWorker.close()]),
    },
    { name: "sessoes", run: () => manager.shutdownAll() },
    { name: "prisma", run: () => prisma.$disconnect() },
  ],
});

void startup().catch((err) => {
  log.error({ err }, "[baileys-worker] Falha na inicialização");
  process.exit(1);
});
