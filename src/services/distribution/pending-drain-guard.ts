/**
 * Guardas da drenagem da fila de espera: cooldown após passagem vazia e
 * quais gatilhos podem furar o cooldown (agente elegível / fila cresceu).
 * Puro — sem Prisma — para o lock in-process em `pending.ts` e testes.
 */

/** Outbound / `capacity_released` não reabre scan completo neste intervalo. */
export const CAPACITY_RELEASED_COOLDOWN_MS = 30_000;

export function shouldSkipCapacityReleasedCooldown(
  trigger: string,
  cooldownUntil: number,
  now = Date.now(),
): boolean {
  return trigger === "capacity_released" && now < cooldownUntil;
}

/** Agente ficou elegível, fila cresceu ou manual — não cron nem outbound. */
export function triggerClearsFruitlessCooldown(trigger: string): boolean {
  return (
    trigger === "agent_online" ||
    trigger === "agent_eligible" ||
    trigger === "new_item" ||
    trigger === "manual"
  );
}

/**
 * Cron (`scheduled`) não fura passagem vazia. Fica no-op até um gatilho
 * real (`agent_online` / `agent_eligible` / `new_item` / `manual`).
 */
export function shouldSkipScheduledFruitlessCooldown(
  trigger: string,
  fruitlessArmed: boolean,
): boolean {
  return trigger === "scheduled" && fruitlessArmed;
}

/** Última passagem armou o cooldown (reason fica até um gatilho real limpar). */
export function fruitlessCooldownIsArmed(
  cooldownReason: string | null,
): boolean {
  return cooldownReason != null;
}

/**
 * Passagem vazia não agenda `setTimeout` para o fim da janela.
 * O `retryInMs` do log é só o restante do cooldown — a próxima varredura
 * vem de `agent_online` / `agent_eligible` / `new_item` / `manual`.
 */
export function shouldScheduleRetryOnCooldownSkip(): boolean {
  return false;
}

/** Passagem sem assign e ainda há gente na espera (skip / capacity exhausted). */
export function fruitlessPassNeedsCooldown(opts: {
  resolved: number;
  pending: number;
}): boolean {
  return opts.resolved === 0 && opts.pending > 0;
}
