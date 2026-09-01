import type { Redis } from "ioredis";

/**
 * ioredis com `enableOfflineQueue: false` rejeita comandos enquanto o
 * socket ainda não é gravável (`wait` / `connecting`) — "Stream isn't
 * writeable". Só `ready` é seguro.
 */
export function isRedisWritable(client: { status: string }): boolean {
  return client.status === "ready";
}

export function waitForRedisWritable(
  client: Redis,
  timeoutMs: number,
): Promise<boolean> {
  if (isRedisWritable(client)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(ok);
    };
    const onReady = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.once("ready", onReady);
    if (isRedisWritable(client)) finish(true);
  });
}
