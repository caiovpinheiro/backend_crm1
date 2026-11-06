/**
 * Limite do sinal de ENTRADA imediata em um negócio
 * (`POST /api/presence/join`): no máximo 1 a cada
 * `PRESENCE_JOIN_MIN_INTERVAL_MS` (5 s) por usuário e entidade — abrir,
 * fechar e abrir de novo o mesmo negócio não vira rajada de escrita.
 *
 * Redis `SET <chave> 1 PX 5000 NX`; sem Redis, mapa do processo. Falha de
 * infraestrutura = fail-open (presença é best-effort).
 */
import { getCacheClient, noteFailure, noteSuccess } from "@/lib/cache/redis-client";

export const PRESENCE_JOIN_MIN_INTERVAL_MS = 5_000;
const KEY_PREFIX = "presence:join-limit:";
const memory = new Map<string, number>();

export function presenceJoinLimitKey(userId: string, entityType: string, entityId: string): string {
  return `${KEY_PREFIX}${userId}:${entityType}:${entityId}`;
}

/** `true` = pode gravar a entrada agora; `false` = entrada recente (só lê). */
export async function claimPresenceJoin(
  params: { userId: string; entityType: string; entityId: string },
  now: number = Date.now(),
): Promise<boolean> {
  const key = presenceJoinLimitKey(params.userId, params.entityType, params.entityId);
  const client = getCacheClient();
  if (client) {
    try {
      const won = await client.set(key, "1", "PX", PRESENCE_JOIN_MIN_INTERVAL_MS, "NX");
      noteSuccess();
      return won === "OK";
    } catch (err) {
      noteFailure(err, key, "presence-join-limit");
      return true;
    }
  }
  const until = memory.get(key) ?? 0;
  if (until > now) return false;
  memory.set(key, now + PRESENCE_JOIN_MIN_INTERVAL_MS);
  if (memory.size > 5_000) {
    for (const [k, t] of memory) if (t <= now) memory.delete(k);
  }
  return true;
}

/** Só para testes. */
export function resetPresenceJoinLimitForTests(): void {
  memory.clear();
}
