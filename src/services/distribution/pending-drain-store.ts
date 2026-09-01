/**
 * Flag Redis da passagem vazia — o cron na API precisa ver o cooldown
 * armado pelo worker (processos distintos, memória não compartilha).
 *
 * Sem Redis (dev / Vitest): peek = false; o cron enfileira e o worker
 * (ou o fallback in-process) aplica o skip local.
 */

import { getRateLimitRedis } from "@/lib/rate-limit";

export function fruitlessCooldownRedisKey(orgId: string): string {
  return `dist:fruitless:${orgId}`;
}

function redis() {
  return getRateLimitRedis();
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

export async function peekPublishedFruitlessCooldown(
  orgId: string,
): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  const v = await r.get(fruitlessCooldownRedisKey(orgId));
  return v != null && v.length > 0;
}
