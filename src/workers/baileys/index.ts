import { prisma } from "@/lib/prisma";
import { drainInFlightTurns } from "@/services/ai/turn-manager";
import { startAiTurnSweeper, stopAiTurnSweeper } from "@/services/ai/turn-sweeper";
import { startListenSweeper } from "@/services/ai-v2/listen";
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
  // Este processo ingere o inbound Baileys, então o turno nasce aqui e
  // precisa de quem o promova — já no boot, para recuperar os órfãos do
  // deploy anterior sem esperar o primeiro inbound.
  startAiTurnSweeper({ force: true });
  startListenSweeper();
  await manager.startAll();
  log.info("[baileys-worker] Pronto — aguardando mensagens e comandos");
}

async function shutdown() {
  log.info("[baileys-worker] Encerrando...");
  stopAiTurnSweeper();
  const drainMs = Number.parseInt(process.env.AI_TURN_SHUTDOWN_DRAIN_MS ?? "", 10);
  await drainInFlightTurns(Number.isFinite(drainMs) && drainMs > 0 ? drainMs : 7000).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "[baileys-worker] drenagem de turnos falhou");
  });
  await manager.shutdownAll();
  await outboundWorker.close();
  await controlWorker.close();
  await prisma.$disconnect();
  log.info("[baileys-worker] Encerrado");
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

void startup().catch((err) => {
  log.error({ err }, "[baileys-worker] Falha na inicialização");
  process.exit(1);
});
