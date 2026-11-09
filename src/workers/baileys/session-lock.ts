/**
 * Trava por canal Baileys no Redis: só um processo abre a sessão de um
 * número por vez. No deploy o worker velho e o novo ficam vivos juntos por
 * alguns segundos; sem trava os dois abriam a mesma sessão e o WhatsApp
 * derrubava um deles (440 connectionReplaced), às vezes em ciclo.
 *
 * - `acquire`: SET NX com validade de 60 s.
 * - `renew`: estende só se ainda é o dono (a cada 20 s).
 * - `release`: apaga só se ainda é o dono (no desligamento).
 * Processo que morre sem soltar libera sozinho em até 60 s.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const SESSION_LOCK_TTL_MS = 60_000;
export const SESSION_LOCK_RENEW_MS = 20_000;

/** Subconjunto do ioredis usado aqui (facilita o teste). */
export interface SessionLockRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export function sessionLockKey(channelId: string): string {
  return `baileys:lock:${channelId}`;
}

/** Identifica este processo nos logs e na trava. */
export const PROCESS_OWNER = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export class SessionLock {
  constructor(
    private readonly redis: SessionLockRedis,
    private readonly owner: string = PROCESS_OWNER,
    private readonly ttlMs: number = SESSION_LOCK_TTL_MS,
  ) {}

  get ownerId(): string {
    return this.owner;
  }

  /** `true` = este processo é o dono (pegou agora ou já era). */
  async acquire(channelId: string): Promise<boolean> {
    const key = sessionLockKey(channelId);
    const ok = await this.redis.set(key, this.owner, "PX", this.ttlMs, "NX");
    if (ok === "OK") return true;
    // Já era nosso (reconexão no mesmo processo): renova.
    return this.renew(channelId);
  }

  async renew(channelId: string): Promise<boolean> {
    const res = await this.redis.eval(RENEW_SCRIPT, 1, sessionLockKey(channelId), this.owner, this.ttlMs);
    return Number(res) === 1;
  }

  async release(channelId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, sessionLockKey(channelId), this.owner);
  }

  /** Dono atual (para log). */
  async holder(channelId: string): Promise<string | null> {
    return this.redis.get(sessionLockKey(channelId));
  }
}
