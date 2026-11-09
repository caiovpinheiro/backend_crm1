import { describe, expect, it } from "vitest";

import { SessionLock, sessionLockKey, type SessionLockRedis } from "./session-lock";

/** Redis em memória com SET NX PX e os dois scripts de dono. */
function fakeRedis(now: () => number): SessionLockRedis & { store: Map<string, { v: string; exp: number }> } {
  const store = new Map<string, { v: string; exp: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.exp <= now()) store.delete(k);
    return store.get(k);
  };
  return {
    store,
    async set(key, value, _px, ttl) {
      if (live(key)) return null;
      store.set(key, { v: value, exp: now() + ttl });
      return "OK";
    },
    async get(key) {
      return live(key)?.v ?? null;
    },
    async eval(script, _n, key, owner, ttl) {
      const e = live(String(key));
      if (!e || e.v !== owner) return 0;
      if (script.includes("pexpire")) {
        e.exp = now() + Number(ttl);
        return 1;
      }
      store.delete(String(key));
      return 1;
    },
  };
}

describe("SessionLock — um processo por número", () => {
  it("o segundo processo não pega a trava enquanto o primeiro é dono", async () => {
    let t = 0;
    const redis = fakeRedis(() => t);
    const velho = new SessionLock(redis, "velho");
    const novo = new SessionLock(redis, "novo");
    expect(await velho.acquire("ch1")).toBe(true);
    expect(await novo.acquire("ch1")).toBe(false);
    expect(await velho.acquire("ch1")).toBe(true); // reconexão do mesmo processo
  });

  it("depois que o velho solta (desligamento), o novo pega", async () => {
    const redis = fakeRedis(() => 0);
    const velho = new SessionLock(redis, "velho");
    const novo = new SessionLock(redis, "novo");
    await velho.acquire("ch1");
    await velho.release("ch1");
    expect(await novo.acquire("ch1")).toBe(true);
    expect(await novo.holder("ch1")).toBe("novo");
  });

  it("processo que morreu sem soltar libera sozinho ao vencer a validade", async () => {
    let t = 0;
    const redis = fakeRedis(() => t);
    await new SessionLock(redis, "morto", 60_000).acquire("ch1");
    t = 60_001;
    expect(await new SessionLock(redis, "novo").acquire("ch1")).toBe(true);
  });

  it("renovar e soltar só funcionam para o dono", async () => {
    const redis = fakeRedis(() => 0);
    const dono = new SessionLock(redis, "dono");
    const outro = new SessionLock(redis, "outro");
    await dono.acquire("ch1");
    expect(await outro.renew("ch1")).toBe(false);
    await outro.release("ch1");
    expect(redis.store.get(sessionLockKey("ch1"))?.v).toBe("dono");
    expect(await dono.renew("ch1")).toBe(true);
  });
});
