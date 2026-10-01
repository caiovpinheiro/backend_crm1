/**
 * `cache.wrapSwr` — stale-while-revalidate (Redis falso, timers falsos).
 *
 * - Fresco: vem do cache.
 * - Vencido dentro do teto: devolve o valor antigo na hora e recalcula em
 *   segundo plano uma vez por chave.
 * - Passado o teto (ttl + stale): bloqueia e recalcula.
 * - Redis fora: mesma regra no fallback em memória.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
    warn: vi.fn(),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { cache } from "@/lib/cache";
import { fakeRedisCalls, fakeRedisRaw } from "@/test-setup/fake-cache-redis";

const START = new Date("2026-01-01T12:00:00.000Z");
const SWR = { ttlSec: 90, staleSec: 90 };

/** Deixa a revalidação em segundo plano terminar. */
async function flushBackground() {
  await vi.advanceTimersByTimeAsync(0);
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  h.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

describe("wrapSwr", () => {
  it("fresco: o loader roda uma vez e a chave vive ttl + stale no Redis", async () => {
    const loader = vi.fn(async () => ({ entrada: 1 }));

    expect(await cache.wrapSwr("swr:fresco", SWR, loader)).toEqual({ entrada: 1 });
    await vi.advanceTimersByTimeAsync(89_000);
    expect(await cache.wrapSwr("swr:fresco", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();

    expect(loader).toHaveBeenCalledTimes(1);
    const expiresAt = h.redis.store.get("cache:swr:fresco")?.expiresAt ?? 0;
    expect(expiresAt - START.getTime()).toBe(180_000);
  });

  it("vencido: devolve o valor antigo na hora e revalida uma vez", async () => {
    let value = 1;
    const slow = gate();
    const loader = vi.fn(async () => {
      if (value > 1) await slow.wait;
      return { entrada: value };
    });

    await cache.wrapSwr("swr:vencido", SWR, loader);
    value = 2;
    await vi.advanceTimersByTimeAsync(91_000);

    // 10 leituras enquanto a revalidação está em andamento: todas recebem
    // o valor antigo sem esperar, e só um loader roda.
    const reads = await Promise.all(
      Array.from({ length: 10 }, () => cache.wrapSwr("swr:vencido", SWR, loader)),
    );
    await flushBackground();
    expect(reads).toEqual(Array.from({ length: 10 }, () => ({ entrada: 1 })));
    expect(await cache.wrapSwr("swr:vencido", SWR, loader)).toEqual({ entrada: 1 });
    expect(loader).toHaveBeenCalledTimes(2);

    slow.release();
    await flushBackground();
    expect(await cache.wrapSwr("swr:vencido", SWR, loader)).toEqual({ entrada: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
    // Lock da revalidação liberado.
    expect(fakeRedisRaw(h.redis, "cache-lock:swr:vencido")).toBeNull();
    expect(fakeRedisCalls(h.redis, "SCAN")).toEqual([]);
  });

  it("revalidado, o valor volta a ser fresco por mais ttl", async () => {
    let value = 1;
    const loader = vi.fn(async () => ({ entrada: value }));

    await cache.wrapSwr("swr:ciclo", SWR, loader);
    value = 2;
    await vi.advanceTimersByTimeAsync(91_000);
    await cache.wrapSwr("swr:ciclo", SWR, loader);
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(2);

    value = 3;
    await vi.advanceTimersByTimeAsync(89_000);
    expect(await cache.wrapSwr("swr:ciclo", SWR, loader)).toEqual({ entrada: 2 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("passado o teto de staleness, bloqueia e recalcula", async () => {
    let value = 1;
    const loader = vi.fn(async () => ({ entrada: value }));

    await cache.wrapSwr("swr:teto", SWR, loader);
    value = 2;
    await vi.advanceTimersByTimeAsync(180_000);

    expect(await cache.wrapSwr("swr:teto", SWR, loader)).toEqual({ entrada: 2 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("outra réplica com o lock: serve o vencido e não roda o loader", async () => {
    let value = 1;
    const loader = vi.fn(async () => ({ entrada: value }));

    await cache.wrapSwr("swr:lock", SWR, loader);
    value = 2;
    await vi.advanceTimersByTimeAsync(91_000);
    h.redis.store.set("cache-lock:swr:lock", { value: "outra-replica", expiresAt: null });

    expect(await cache.wrapSwr("swr:lock", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(await cache.wrapSwr("swr:lock", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(1);
    // Não disputa o lock a cada leitura.
    expect(fakeRedisCalls(h.redis, "SET cache-lock:swr:lock")).toHaveLength(2);

    // A outra réplica terminou sem gravar (caiu): passado o backoff, esta assume.
    h.redis.store.delete("cache-lock:swr:lock");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await cache.wrapSwr("swr:lock", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await cache.wrapSwr("swr:lock", SWR, loader)).toEqual({ entrada: 2 });
  });

  it("revalidação falhando: mantém o vencido e só tenta de novo depois de 5 s", async () => {
    let fail = false;
    const loader = vi.fn(async () => {
      if (fail) throw new Error("db fora");
      return { entrada: 1 };
    });

    await cache.wrapSwr("swr:falha", SWR, loader);
    fail = true;
    await vi.advanceTimersByTimeAsync(91_000);

    expect(await cache.wrapSwr("swr:falha", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: "swr:falha" }),
      "[cache] revalidação em segundo plano falhou",
    );

    await vi.advanceTimersByTimeAsync(4_000);
    expect(await cache.wrapSwr("swr:falha", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(2);

    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await cache.wrapSwr("swr:falha", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("carga inicial falhando propaga o erro (não há valor antigo)", async () => {
    await expect(
      cache.wrapSwr("swr:frio", SWR, async () => {
        throw new Error("db fora");
      }),
    ).rejects.toThrow("db fora");
  });

  it("chamadas simultâneas na chave fria dividem um loader", async () => {
    const loader = vi.fn(async () => ({ entrada: 1 }));
    const reads = await Promise.all(
      Array.from({ length: 8 }, () => cache.wrapSwr("swr:rajada", SWR, loader)),
    );
    expect(reads).toHaveLength(8);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("peekSwr", () => {
  it("lê fresco ou vencido sem recalcular; ausente = undefined", async () => {
    const loader = vi.fn(async () => ({ entrada: 4 }));
    expect(await cache.peekSwr("swr:peek")).toBeUndefined();

    await cache.wrapSwr("swr:peek", SWR, loader);
    expect(await cache.peekSwr("swr:peek")).toEqual({ entrada: 4 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await cache.peekSwr("swr:peek")).toEqual({ entrada: 4 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await cache.peekSwr("swr:peek")).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("valor fora do formato SWR não é devolvido", async () => {
    await cache.set("swr:legado", { entrada: 9 }, 60);
    expect(await cache.peekSwr("swr:legado")).toBeUndefined();
  });
});

describe("wrapSwr com o Redis fora", () => {
  it("cai no fallback em memória com a mesma regra", async () => {
    vi.resetModules();
    h.redis.down = true;
    const fresh = await import("@/lib/cache");
    let value = 1;
    const loader = vi.fn(async () => ({ entrada: value }));

    expect(await fresh.cache.wrapSwr("swr:fora", SWR, loader)).toEqual({ entrada: 1 });
    expect(await fresh.cache.wrapSwr("swr:fora", SWR, loader)).toEqual({ entrada: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(h.redis.store.size).toBe(0);

    // Vencido: valor antigo na hora, uma revalidação em segundo plano.
    value = 2;
    await vi.advanceTimersByTimeAsync(91_000);
    expect(await fresh.cache.wrapSwr("swr:fora", SWR, loader)).toEqual({ entrada: 1 });
    expect(await fresh.cache.wrapSwr("swr:fora", SWR, loader)).toEqual({ entrada: 1 });
    await flushBackground();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await fresh.cache.wrapSwr("swr:fora", SWR, loader)).toEqual({ entrada: 2 });

    // Teto: some da memória e a leitura recalcula.
    value = 3;
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await fresh.cache.wrapSwr("swr:fora", SWR, loader)).toEqual({ entrada: 3 });
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
