/**
 * Guardas da drenagem da fila de espera: cooldown após passagem vazia e
 * quais gatilhos podem furar o cooldown (agente elegível / fila cresceu).
 * Puro — sem Prisma — para o lock in-process em `pending.ts` e testes.
 */

export const CAPACITY_RELEASED_COOLDOWN_MS = 8_000;

export function shouldSkipCapacityReleasedCooldown(
  trigger: string,
  cooldownUntil: number,
  now = Date.now(),
): boolean {
  return trigger === "capacity_released" && now < cooldownUntil;
}

/** Agente ficou elegível, fila cresceu, manual ou cron — não o outbound. */
export function triggerClearsFruitlessCooldown(trigger: string): boolean {
  return (
    trigger === "agent_online" ||
    trigger === "agent_eligible" ||
    trigger === "new_item" ||
    trigger === "manual" ||
    trigger === "scheduled"
  );
}

/** Passagem sem assign e ainda há gente na espera (skip / capacity exhausted). */
export function fruitlessPassNeedsCooldown(opts: {
  resolved: number;
  pending: number;
}): boolean {
  return opts.resolved === 0 && opts.pending > 0;
}
