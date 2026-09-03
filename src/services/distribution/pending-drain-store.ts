/**
 * Flag Redis da passagem vazia — o cron (`scheduled`) e o producer
 * `capacity_released` precisam ver o cooldown armado pelo worker
 * (processos distintos, memória não compartilha).
 *
 * Usa a conexão BullMQ (`enableOfflineQueue` default true) — o client
 * de rate-limit / cache (`enableOfflineQueue: false`) rejeita SET/GET
 * no boot ("Stream isn't writeable") e o cooldown não cruzava processos.
 *
 * Sem Redis (dev / Vitest): peek = false; o cron enfileira e o worker
 * (ou o fallback in-process) aplica o skip local.
 */

import {
  getBullConnection,
  isRedisConfigured,
} from "@/lib/queue-connection";

export function fruitlessCooldownRedisKey(orgId: string): string {
  return `dist:fruitless:${orgId}`;
}

function redis() {
  if (process.env.VITEST === "true") return null;
  if (!isRedisConfigured()) return null;
  return getBullConnection();
}

export async function publishFruitlessCooldown(
  orgId: string,
  reason: string,
): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(fruitlessCooldownRedisKey(orgId), reason);
}

export async function clearPublishedFruitlessCooldown(
  orgId: string,
): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.del(fruitlessCooldownRedisKey(orgId));
}

export type FruitlessCooldownPeek = {
  armed: boolean;
  /** PTTL em ms. null = sem Redis, chave sem expiry, ou ausente. */
  ttlMs: number | null;
};

export async function peekPublishedFruitlessCooldown(
  orgId: string,
): Promise<FruitlessCooldownPeek> {
  const r = redis();
  if (!r) return { armed: false, ttlMs: null };
  const key = fruitlessCooldownRedisKey(orgId);
  const [v, pttl] = await Promise.all([r.get(key), r.pttl(key)]);
  return {
    armed: v != null && v.length > 0,
    ttlMs: typeof pttl === "number" && pttl >= 0 ? pttl : null,
  };
}
