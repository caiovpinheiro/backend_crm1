import { prisma } from "@/lib/prisma";
import { startAiTurnSweeper } from "@/services/ai/turn-sweeper";
import { BaileysManager } from "./baileys-manager";
import { startOutboundConsumer } from "./outbound-consumer";
import { startControlConsumer } from "./control-consumer";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const manager = new BaileysManager();

const outboundWorker = startOutboundConsumer(manager, redisUrl);
const controlWorker = startControlConsumer(manager, redisUrl);

async function startup() {
  console.info("[baileys-worker] Iniciando...");
  // Turn Manager (AI_TURN_MANAGER=1): este processo ingere o inbound
  // Baileys, então o turno nasce aqui e precisa de quem o promova.
  // No-op com a flag desligada.
  startAiTurnSweeper();
  await manager.startAll();
  console.info("[baileys-worker] Pronto — aguardando mensagens e comandos");
}

async function shutdown() {
  console.info("[baileys-worker] Encerrando...");
  await manager.shutdownAll();
  await outboundWorker.close();
  await controlWorker.close();
  await prisma.$disconnect();
  console.info("[baileys-worker] Encerrado");
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

void startup().catch((err) => {
  console.error("[baileys-worker] Falha na inicialização:", err);
  process.exit(1);
});
