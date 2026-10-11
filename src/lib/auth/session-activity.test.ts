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
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: { $queryRaw: h.queryRaw } }));

vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => h.client.current,
  noteSuccess: vi.fn(),
  noteFailure: vi.fn(),
}));

import {
  SESSION_ACTIVITY_CACHE_MS,
  parseLastInteractionAt,
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
  delete process.env.SESSION_IDLE_HOURS;
  h.queryRaw.mockReset();
  h.queryRaw.mockResolvedValue([{ lastActivityAt: null, lastLoginAt: null }]);
});

/** Linha da consulta de semente (`lastRealActivityFromDb`). */
function dbRow(lastActivityAt: number | null, lastLoginAt: number | null = null) {
  return [
    {
      lastActivityAt: lastActivityAt === null ? null : new Date(lastActivityAt),
      lastLoginAt: lastLoginAt === null ? null : new Date(lastLoginAt),
    },
  ];
}

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

  it("SESSION_IDLE_HOURS é o nome preferido; SESSION_IDLE_TIMEOUT_HOURS segue como alias", () => {
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_HOURS: "6" })).toBe(6 * HOUR);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_TIMEOUT_HOURS: "4" })).toBe(4 * HOUR);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_HOURS: "6", SESSION_IDLE_TIMEOUT_HOURS: "4" })).toBe(6 * HOUR);
    // Nome novo inválido: cai no alias; os dois inválidos: padrão.
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_HOURS: "x", SESSION_IDLE_TIMEOUT_HOURS: "4" })).toBe(4 * HOUR);
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_HOURS: "0", SESSION_IDLE_TIMEOUT_HOURS: "-1" })).toBe(12 * HOUR);
    // Fração: 0.05 h = 3 min (teste na DEV).
    expect(sessionIdleTimeoutMs({ SESSION_IDLE_HOURS: "0.05" })).toBe(180_000);
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

describe("isSessionIdleExpired — semente do banco quando o Redis não tem registro", () => {
  it("última atividade no banco há 13 h → expira e o Redis guarda esse valor (1 consulta só)", async () => {
    h.queryRaw.mockResolvedValue(dbRow(T0 - 13 * HOUR));
    expect(await isSessionIdleExpired({ ...REF, organizationId: "org1" }, T0)).toBe(true);
    expect(fakeRedisRaw(state, sessionActivityKey(REF))).toBe(String(T0 - 13 * HOUR));
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 1_000)).toBe(true);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("última atividade no banco há 1 h → passa; semeado com ela, expira 11 h depois", async () => {
    h.queryRaw.mockResolvedValue(dbRow(T0 - HOUR));
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    expect(fakeRedisRaw(state, sessionActivityKey(REF))).toBe(String(T0 - HOUR));
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + 11 * HOUR + 1_000)).toBe(true);
  });

  it("login mais recente que a atividade conta como piso", async () => {
    h.queryRaw.mockResolvedValue(dbRow(T0 - 20 * HOUR, T0 - 2 * HOUR));
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    expect(fakeRedisRaw(state, sessionActivityKey(REF))).toBe(String(T0 - 2 * HOUR));
  });

  it("sem nenhuma linha de atividade (ex.: só app mobile) → semeia agora e passa, mesmo com login antigo", async () => {
    h.queryRaw.mockResolvedValue(dbRow(null, T0 - 48 * HOUR));
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    expect(fakeRedisRaw(state, sessionActivityKey(REF))).toBe(String(T0));
  });

  it("registro já no Redis → não consulta o banco", async () => {
    await touchSessionActivity(REF, T0);
    clearSessionActivityCacheForTests();
    expect(await isSessionIdleExpired(REF, T0 + HOUR)).toBe(false);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("banco fora → passa sem semear; tenta de novo depois do cache", async () => {
    h.queryRaw.mockRejectedValue(new Error("db down"));
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    expect(fakeRedisRaw(state, sessionActivityKey(REF))).toBeNull();
    expect(await isSessionIdleExpired(REF, T0 + 1_000)).toBe(false);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    h.queryRaw.mockResolvedValue(dbRow(T0 - 13 * HOUR));
    expect(await isSessionIdleExpired(REF, T0 + SESSION_ACTIVITY_CACHE_MS + 1)).toBe(true);
  });

  it("Redis fora → não consulta o banco (fail-open)", async () => {
    state.down = true;
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    h.client.current = null;
    expect(await isSessionIdleExpired(REF, T0)).toBe(false);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

describe("parseLastInteractionAt", () => {
  it("ISO, epoch ms (número ou texto); futuro, ilegível e ausente → null", () => {
    expect(parseLastInteractionAt(new Date(T0 - HOUR).toISOString(), T0)).toBe(T0 - HOUR);
    expect(parseLastInteractionAt(T0 - HOUR, T0)).toBe(T0 - HOUR);
    expect(parseLastInteractionAt(String(T0 - HOUR), T0)).toBe(T0 - HOUR);
    expect(parseLastInteractionAt(T0 + 1, T0)).toBeNull();
    for (const v of [undefined, null, "", "ontem", -5, 0, Number.NaN, {}, true]) {
      expect(parseLastInteractionAt(v, T0)).toBeNull();
    }
  });
});
