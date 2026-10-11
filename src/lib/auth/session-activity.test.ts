/**
 * Expiração por inatividade real (`session-activity.ts`): registro por
 * sessão no Redis (falso, em memória), cache curto em memória, semeadura
 * sem registro (deploy não desloga ninguém) e fail-open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeIoredisModule,
  fakeRedisCalls,
  fakeRedisRaw,
  newFakeRedisState,
} from "@/test-setup/fake-cache-redis";

const h = vi.hoisted(() => ({
  client: { current: null as unknown },
}));

vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => h.client.current,
  noteSuccess: vi.fn(),
  noteFailure: vi.fn(),
}));

import {
  SESSION_ACTIVITY_CACHE_MS,
  SESSION_ACTIVITY_TTL_MS,
  clearSessionActivityCacheForTests,
  isSessionIdleExpired,
  sessionActivityKey,
  sessionIdleTimeoutMs,
  touchSessionActivity,
} from "./session-activity";

const HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;
const REF = { userId: "u1", sid: "sid-1" };

let state = newFakeRedisState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  state = newFakeRedisState();
  const { default: FakeRedis } = fakeIoredisModule(state);
  h.client.current = new FakeRedis();
  clearSessionActivityCacheForTests();
  delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sessionIdleTimeoutMs / sessionActivityKey", () => {
  it("padrão 12 h; env válida (inclusive fração) vale; inválida/≤0 cai no padrão", () => {
    expect(sessionIdleTimeoutMs({})).toBe(12 * HOUR);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_HOURS: "8" })).toBe(8 * HOUR);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_HOURS: "0.5" })).toBe(HOUR / 2);
    for (const v of ["0", "-3", "abc", ""]) {
      expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_HOURS: v })).toBe(12 * HOUR);
    }
  });

  it("chave por sid; token antigo sem sid cai no nível do usuário", () => {
    expect(sessionActivityKey(REF)).toBe("auth:session-activity:sid:sid-1");
    expect(sessionActivityKey({ userId: "u1" })).toBe("auth:session-activity:user:u1");
    expect(sessionActivityKey({ userId: "u1", sid: null })).toBe("auth:session-activity:user:u1");
  });
});

describe("isSessionIdleExpired", () => {
  it("atividade há 11 h → não expira; há 13 h → expira", async () => {
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 11 * HOUR)).toBe(false);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 13 * HOUR)).toBe(true);
  });

  it("sem registro (primeiro deploy): semeia com agora e passa; 13 h depois sem atividade, expira", async () => {
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    expect(fakeRedisRaw(state, sessionActivityKey(REF))).toBe(String(T0));
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 13 * HOUR)).toBe(true);
  });

  it("o registro guarda TTL longo (> 12 h e > vida do JWT)", async () => {
    await touchSessionActivity(REF, T0);
    const ttl = state.store.get(sessionActivityKey(REF))?.expiresAt;
    expect(ttl).toBe(Date.now() + SESSION_ACTIVITY_TTL_MS);
    expect(SESSION_ACTIVITY_TTL_MS).toBeGreaterThan(30 * 24 * HOUR);
  });

  it("cache em memória: dentro de 30 s não volta ao Redis", async () => {
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    await isSessionIdleExpired(REF, T0 + HOUR);
    const gets = fakeRedisCalls(state, "GET").length;
    await isSessionIdleExpired(REF, T0 + HOUR + 10_000);
    await isSessionIdleExpired(REF, T0 + HOUR + 20_000);
    expect(fakeRedisCalls(state, "GET").length).toBe(gets);
    await isSessionIdleExpired(REF, T0 + HOUR + SESSION_ACTIVITY_CACHE_MS + 1);
    expect(fakeRedisCalls(state, "GET").length).toBe(gets + 1);
  });

  it("cache diz 'expirou' mas outra réplica registrou atividade: reconfirma no Redis e passa", async () => {
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    // Leitura às 11h59m50s: ainda válida, fica no cache com last = T0.
    expect(await isSessionIdleExpired(REF, T0 + 12 * HOUR - 10_000)).toBe(false);
    // Outra réplica registra atividade direto no Redis (sem passar por este cache).
    state.store.set(sessionActivityKey(REF), {
      value: String(T0 + 12 * HOUR - 5_000),
      expiresAt: null,
    });
    // 15 s depois: pelo cache (20 s de idade) já teria expirado — confere no Redis.
    expect(await isSessionIdleExpired(REF, T0 + 12 * HOUR + 5_000)).toBe(false);
  });

  it("expirada é terminal no cache e renova o TTL da chave (não 'renasce')", async () => {
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 13 * HOUR)).toBe(true);
    expect(fakeRedisCalls(state, "PEXPIRE").length).toBe(1);
    const gets = fakeRedisCalls(state, "GET").length;
    expect(await isSessionIdleExpired(REF, T0 + 13 * HOUR + 5_000)).toBe(true);
    expect(fakeRedisCalls(state, "GET").length).toBe(gets);
  });

  it("toque (activity) renova: 11 h + toque + 11 h → não expira", async () => {
    await touchSessionActivity(REF, T0);
    await touchSessionActivity(REF, T0 + 11 * HOUR);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 22 * HOUR)).toBe(false);
  });

  it("sessões diferentes não se misturam; token sem sid usa a chave do usuário", async () => {
    await touchSessionActivity({ userId: "u1", sid: "a" }, T0);
    await touchSessionActivity({ userId: "u1", sid: "b" }, T0 + 10 * HOUR);
    await touchSessionActivity({ userId: "u1" }, T0 + 10 * HOUR);
    clearSessionActivityCacheForTests();
    const at = T0 + 13 * HOUR;
    expect(await isSessionIdleExpired({ userId: "u1", sid: "a" }, at)).toBe(true);
    expect(await isSessionIdleExpired({ userId: "u1", sid: "b" }, at)).toBe(false);
    expect(await isSessionIdleExpired({ userId: "u1" }, at)).toBe(false);
  });

  it("SESSION_IDLE_TIMEOUT_HOURS muda o limite", async () => {
    process.env.SESSION_IDLE_TIMEOUT_HOURS = "2";
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 3 * HOUR)).toBe(true);
  });

  it("Redis fora ou ausente: fail-open (não expira ninguém)", async () => {
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    state.down = true;
    expect(await isSessionIdleExpired(REF, T0 + 13 * HOUR)).toBe(false);
    h.client.current = null;
    expect(await isSessionIdleExpired(REF, T0 + 13 * HOUR)).toBe(false);
    // Toque com Redis fora também não lança.
    await expect(touchSessionActivity(REF)).resolves.toBeUndefined();
  });
});
