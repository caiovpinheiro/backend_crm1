/**
 * Versões das famílias de cache (Redis falso em memória, timers falsos).
 *
 * - Invalidar é um INCR: nenhum SCAN.
 * - A versão é lida no Redis no máximo uma vez por janela (500 ms).
 * - No processo que invalidou, a versão nova vale na hora.
 * - Redis fora: a versão vive na memória e o bump é reaplicado depois.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  delete process.env.CACHE_VERSION_MEMO_MS;
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  bumpCacheVersion,
  cacheVersionMemoMs,
  cacheVersionName,
  cacheVersionRedisKey,
  getCacheVersion,
  getCacheVersions,
  resetCacheVersionsForTests,
} from "@/lib/cache/versions";
import { fakeRedisCalls, fakeRedisRaw } from "@/test-setup/fake-cache-redis";

const START = new Date("2026-01-01T12:00:00.000Z");

function redisVersion(name: string): string | null {
  return fakeRedisRaw(h.redis, cacheVersionRedisKey(name));
}

/** Simula o INCR feito por OUTRO processo (direto no Redis). */
function bumpFromAnotherProcess(name: string): void {
  const key = cacheVersionRedisKey(name);
  const hit = h.redis.store.get(key);
  if (!hit) throw new Error(`versão ${name} não existe no Redis falso`);
  hit.value = String(Number(hit.value) + 1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  resetCacheVersionsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CACHE_VERSION_MEMO_MS;
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

describe("nome e chave da versão", () => {
  it("cache:v:<família>:<org>[:<pipeline>]", () => {
    expect(cacheVersionRedisKey(cacheVersionName("board", "org-1"))).toBe(
      "cache:v:board:org-1",
    );
    expect(cacheVersionRedisKey(cacheVersionName("board", "org-1", "pipe-9"))).toBe(
      "cache:v:board:org-1:pipe-9",
    );
  });

  it("a primeira leitura cria a versão no Redis, com TTL", async () => {
    const version = await getCacheVersion("board:org-1");
    expect(version).toBe(START.getTime().toString(36));
    expect(redisVersion("board:org-1")).toBe(String(START.getTime()));
    const expiresAt = h.redis.store.get("cache:v:board:org-1")?.expiresAt ?? 0;
    expect(expiresAt - START.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("leitura da versão", () => {
  it("vai ao Redis uma vez por janela de 500 ms", async () => {
    expect(cacheVersionMemoMs()).toBe(500);
    const first = await getCacheVersion("board:org-1");
    h.redis.calls.length = 0;

    for (let i = 0; i < 20; i++) {
      expect(await getCacheVersion("board:org-1")).toBe(first);
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(await getCacheVersion("board:org-1")).toBe(first);
    expect(h.redis.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(await getCacheVersion("board:org-1")).toBe(first);
    expect(await getCacheVersion("board:org-1")).toBe(first);
    expect(h.redis.calls).toEqual(["GET cache:v:board:org-1"]);
  });

  it("leituras simultâneas da mesma versão dividem uma ida ao Redis", async () => {
    await getCacheVersion("board:org-1");
    await vi.advanceTimersByTimeAsync(500);
    h.redis.calls.length = 0;

    const all = await Promise.all(
      Array.from({ length: 10 }, () => getCacheVersion("board:org-1")),
    );
    expect(new Set(all).size).toBe(1);
    expect(h.redis.calls).toEqual(["GET cache:v:board:org-1"]);
  });

  it("bump de outro processo aparece no máximo 500 ms depois", async () => {
    const before = await getCacheVersion("inbox_tab_counts:org-1");
    bumpFromAnotherProcess("inbox_tab_counts:org-1");

    await vi.advanceTimersByTimeAsync(499);
    expect(await getCacheVersion("inbox_tab_counts:org-1")).toBe(before);

    await vi.advanceTimersByTimeAsync(1);
    expect(await getCacheVersion("inbox_tab_counts:org-1")).not.toBe(before);
  });

  it("CACHE_VERSION_MEMO_MS=0 lê sempre; valor inválido cai no default; teto 2 s", async () => {
    process.env.CACHE_VERSION_MEMO_MS = "abc";
    expect(cacheVersionMemoMs()).toBe(500);
    process.env.CACHE_VERSION_MEMO_MS = "60000";
    expect(cacheVersionMemoMs()).toBe(2_000);

    process.env.CACHE_VERSION_MEMO_MS = "0";
    const before = await getCacheVersion("board:org-1");
    bumpFromAnotherProcess("board:org-1");
    expect(await getCacheVersion("board:org-1")).not.toBe(before);
  });

  it("versão que sumiu do Redis é recriada com número maior que o anterior", async () => {
    const before = await getCacheVersion("board:org-1");
    await bumpCacheVersion("board:org-1");
    const bumped = await getCacheVersion("board:org-1");

    h.redis.store.delete("cache:v:board:org-1");
    await vi.advanceTimersByTimeAsync(500);
    const recreated = await getCacheVersion("board:org-1");

    expect(parseInt(bumped, 36)).toBe(parseInt(before, 36) + 1);
    expect(parseInt(recreated, 36)).toBeGreaterThan(parseInt(bumped, 36));
  });
});

describe("invalidação por versão", () => {
  it("é um INCR: não chama SCAN e a versão nova vale na hora neste processo", async () => {
    const before = await getCacheVersion("board:org-1:pipe-1");
    h.redis.calls.length = 0;

    await bumpCacheVersion("board:org-1:pipe-1");
    const after = await getCacheVersion("board:org-1:pipe-1");

    expect(after).not.toBe(before);
    expect(redisVersion("board:org-1:pipe-1")).toBe(String(START.getTime() + 1));
    expect(fakeRedisCalls(h.redis, "SCAN")).toEqual([]);
    // Uma ida ao Redis para o bump; a leitura seguinte saiu da memória.
    expect(h.redis.calls).toEqual(["MULTI 3"]);
  });

  it("bump de versão que nunca foi lida também cria a chave", async () => {
    await bumpCacheVersion("authz:org-nova");
    expect(redisVersion("authz:org-nova")).toBe(String(START.getTime() + 1));
    expect(await getCacheVersion("authz:org-nova")).toBe(
      (START.getTime() + 1).toString(36),
    );
  });

  it("quem lê enquanto o bump está a caminho recebe a versão nova", async () => {
    const before = await getCacheVersion("board:org-1");
    const bump = bumpCacheVersion("board:org-1");
    const during = await getCacheVersion("board:org-1");
    await bump;
    expect(during).not.toBe(before);
    expect(during).toBe(await getCacheVersion("board:org-1"));
  });

  it("duas orgs não se invalidam", async () => {
    const [a, b] = await getCacheVersions("board:org-a", "board:org-b");
    await bumpCacheVersion("board:org-a");
    const [a2, b2] = await getCacheVersions("board:org-a", "board:org-b");
    expect(a2).not.toBe(a);
    expect(b2).toBe(b);
    expect(redisVersion("board:org-b")).toBe(String(START.getTime()));
  });

  it("org e pipeline têm versões separadas", async () => {
    const names = ["board:org-1", "board:org-1:pipe-1", "board:org-1:pipe-2"];
    const before = await getCacheVersions(...names);
    await bumpCacheVersion("board:org-1:pipe-1");
    const after = await getCacheVersions(...names);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it("vários bumps seguidos somam um por um", async () => {
    await getCacheVersion("board:org-1");
    await Promise.all([
      bumpCacheVersion("board:org-1"),
      bumpCacheVersion("board:org-1"),
      bumpCacheVersion("board:org-1"),
    ]);
    expect(redisVersion("board:org-1")).toBe(String(START.getTime() + 3));
    expect(await getCacheVersion("board:org-1")).toBe(
      (START.getTime() + 3).toString(36),
    );
  });
});

describe("Redis fora", () => {
  it("a versão continua valendo na memória e o bump invalida no processo", async () => {
    const before = await getCacheVersion("board:org-1");
    h.redis.down = true;

    await vi.advanceTimersByTimeAsync(500);
    expect(await getCacheVersion("board:org-1")).toBe(before);

    await bumpCacheVersion("board:org-1");
    const after = await getCacheVersion("board:org-1");
    expect(after).not.toBe(before);
    // O Redis não viu o bump.
    h.redis.down = false;
    expect(redisVersion("board:org-1")).toBe(String(START.getTime()));
  });

  it("o bump pendente é reaplicado quando o Redis volta", async () => {
    await getCacheVersion("board:org-1");
    h.redis.down = true;
    await bumpCacheVersion("board:org-1");
    await bumpCacheVersion("board:org-1");
    const local = await getCacheVersion("board:org-1");

    h.redis.down = false;
    await vi.advanceTimersByTimeAsync(500);
    const back = await getCacheVersion("board:org-1");

    expect(redisVersion("board:org-1")).toBe(String(START.getTime() + 2));
    expect(back).toBe(local);
    // Aplicado uma vez só.
    await vi.advanceTimersByTimeAsync(500);
    await getCacheVersion("board:org-1");
    expect(redisVersion("board:org-1")).toBe(String(START.getTime() + 2));
  });

  it("versão nunca lida, com o Redis fora, nasce na memória", async () => {
    h.redis.down = true;
    const first = await getCacheVersion("board:org-fria");
    expect(await getCacheVersion("board:org-fria")).toBe(first);
    await bumpCacheVersion("board:org-fria");
    expect(await getCacheVersion("board:org-fria")).not.toBe(first);
  });
});

describe("sem Redis configurado", () => {
  it("versões só em memória, com a mesma semântica", async () => {
    vi.resetModules();
    const savedUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const local = await import("@/lib/cache/versions");
      h.redis.calls.length = 0;

      const [a, b] = await local.getCacheVersions("board:org-a", "board:org-b");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await local.getCacheVersion("board:org-a")).toBe(a);

      await local.bumpCacheVersion("board:org-a");
      expect(await local.getCacheVersion("board:org-a")).not.toBe(a);
      expect(await local.getCacheVersion("board:org-b")).toBe(b);
      expect(h.redis.calls).toEqual([]);
    } finally {
      process.env.REDIS_URL = savedUrl;
    }
  });
});
