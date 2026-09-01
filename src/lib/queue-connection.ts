import IORedis, { type RedisOptions } from "ioredis";

import { waitForRedisWritable } from "@/lib/redis-ready";

/**
 * Conexão IORedis compartilhada para os novos workers/queues BullMQ.
 *
 * Centraliza a configuração obrigatória que BullMQ exige:
 *   - `maxRetriesPerRequest: null`
 *   - `enableReadyCheck: false`
 *
 * Sem essas opções, o blocking `BRPOP` interno do BullMQ tropeça em
 * retry caps do ioredis e os workers começam a derrubar conexões
 * silenciosamente. Esses defaults vêm do próprio doc do BullMQ.
 *
 * Por que um arquivo novo (e não reusar o singleton de `src/lib/queue.ts`)?
 *   - `queue.ts` mantém um singleton global por motivos históricos
 *     (Next App Router faz hot-reload + dev-time HMR cria múltiplas
 *     instâncias do módulo); preservar o comportamento existente sem
 *     refatorar é mais seguro.
 *   - Workers (processos `tsx`/`node` separados) não sofrem desse problema
 *     mas precisam de uma conexão limpa (sem flags incompatíveis com BullMQ
 *     Worker, que difere do Queue producer).
 *
 * No futuro, workers legados (campaign, baileys, automation) podem migrar
 * para esse helper sem mudança de comportamento.
 */

const REDIS_URL = process.env.REDIS_URL;

let cachedConnection: IORedis | null = null;

const DEFAULT_OPTIONS: RedisOptions = {
  // BullMQ exige `null` — não pode ter retry cap.
  maxRetriesPerRequest: null,
  // BullMQ não usa o ready-check do ioredis e ele atrapalha em alguns
  // managed Redis (Upstash, EasyPanel managed).
  enableReadyCheck: false,
  // Reconexão exponencial truncada — evita storm de reconnect em failovers.
  retryStrategy(times) {
    return Math.min(times * 200, 5_000);
  },
};

/**
 * Retorna a conexão IORedis singleton dos novos workers/queues.
 *
 * Lança se `REDIS_URL` não estiver definida — workers BullMQ não rodam
 * sem Redis e silenciar a falha aqui esconde o problema operacional.
 */
export function getBullConnection(): IORedis {
  if (!REDIS_URL) {
    throw new Error(
      "[queue-connection] REDIS_URL is required for BullMQ workers/queues",
    );
  }
  if (!cachedConnection) {
    cachedConnection = new IORedis(REDIS_URL, DEFAULT_OPTIONS);
    cachedConnection.on("error", (err) => {
      console.error("[queue-connection] redis error:", err.message);
    });
  }
  return cachedConnection;
}

/**
 * Duplica a conexão para usos que exigem socket próprio
 * (ex.: Worker concorrente, QueueEvents, pub/sub).
 *
 * BullMQ docs recomendam `connection.duplicate()` para cada Worker
 * adicional na mesma processo para não compartilhar buffer do BRPOP.
 */
export function duplicateBullConnection(): IORedis {
  return getBullConnection().duplicate();
}

/**
 * Fecha a conexão (uso em testes ou em graceful shutdown explícito).
 */
export async function closeBullConnection(): Promise<void> {
  if (cachedConnection) {
    await cachedConnection.quit().catch(() => {});
    cachedConnection = null;
  }
}

/**
 * Retorna `true` se a env tá configurada — usado por endpoints que
 * precisam decidir se devem enfileirar ou executar inline (fallback dev).
 */
export function isRedisConfigured(): boolean {
  return Boolean(REDIS_URL);
}

/** Espera o singleton BullMQ ficar `ready` (handshake TCP). */
export async function waitUntilBullReady(
  timeoutMs = 8_000,
): Promise<boolean> {
  if (!REDIS_URL) return false;
  return waitForRedisWritable(getBullConnection(), timeoutMs);
}
