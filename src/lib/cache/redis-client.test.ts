/**
 * Conexão do cache: `REDIS_CACHE_URL` / `REDIS_CACHE_DB` (Redis falso, sem
 * rede). Sem as duas envs o cache conecta exatamente no `REDIS_URL`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  constructed: [] as Array<{ url: string; options: Record<string, unknown> }>,
}));

vi.mock("ioredis", () => {
  class FakeRedis {
    status = "ready";
    constructor(url: string, options: Record<string, unknown>) {
      h.constructed.push({ url, options });
    }
    on() {
      return this;
    }
    disconnect() {}
    async get() {
      return null;
    }
  }
  return { default: FakeRedis };
});

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { resolveCacheRedisTarget } from "@/lib/cache/redis-client";

const BASE = "rediss://default:s3nha@fake-redis.localhost:25061";

describe("resolveCacheRedisTarget", () => {
  it("sem REDIS_URL nem REDIS_CACHE_URL: sem Redis (fallback em memória)", () => {
    expect(resolveCacheRedisTarget({})).toBeNull();
    expect(resolveCacheRedisTarget({ REDIS_CACHE_DB: "3" })).toBeNull();
  });

  it("default: exatamente o REDIS_URL, sem trocar db", () => {
    expect(resolveCacheRedisTarget({ REDIS_URL: BASE })).toEqual({
      url: BASE,
      db: null,
      source: "REDIS_URL",
    });
    expect(resolveCacheRedisTarget({ REDIS_URL: `${BASE}/2` })).toEqual({
      url: `${BASE}/2`,
      db: null,
      source: "REDIS_URL",
    });
  });

  it("REDIS_CACHE_DB põe o db no path da URL", () => {
    expect(
      resolveCacheRedisTarget({ REDIS_URL: BASE, REDIS_CACHE_DB: "3" }),
    ).toEqual({ url: `${BASE}/3`, db: 3, source: "REDIS_URL" });
  });

  it("REDIS_CACHE_DB substitui o db que a URL já tinha e preserva a query", () => {
    expect(
      resolveCacheRedisTarget({
        REDIS_URL: `${BASE}/0?family=6`,
        REDIS_CACHE_DB: " 7 ",
      }),
    ).toEqual({ url: `${BASE}/7?family=6`, db: 7, source: "REDIS_URL" });
  });

  it("REDIS_CACHE_URL tem precedência sobre REDIS_URL", () => {
    const own = "redis://cache.localhost:6379/1";
    expect(
      resolveCacheRedisTarget({ REDIS_URL: BASE, REDIS_CACHE_URL: own }),
    ).toEqual({ url: own, db: null, source: "REDIS_CACHE_URL" });
    expect(
      resolveCacheRedisTarget({
        REDIS_URL: BASE,
        REDIS_CACHE_URL: own,
        REDIS_CACHE_DB: "4",
      }),
    ).toEqual({
      url: "redis://cache.localhost:6379/4",
      db: 4,
      source: "REDIS_CACHE_URL",
    });
  });

  it("REDIS_CACHE_URL vazio ou REDIS_CACHE_DB inválido não mudam o default", () => {
    for (const bad of ["", "  ", "-1", "1.5", "abc"]) {
      expect(
        resolveCacheRedisTarget({
          REDIS_URL: BASE,
          REDIS_CACHE_URL: " ",
          REDIS_CACHE_DB: bad,
        }),
      ).toEqual({ url: BASE, db: null, source: "REDIS_URL" });
    }
  });

  it("URL fora do formato redis(s):// fica intacta e o db vai por opção", () => {
    expect(
      resolveCacheRedisTarget({ REDIS_URL: "/tmp/redis.sock", REDIS_CACHE_DB: "2" }),
    ).toEqual({ url: "/tmp/redis.sock", db: 2, source: "REDIS_URL" });
  });
});

describe("cliente do cache", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    h.constructed.length = 0;
    vi.resetModules();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_CACHE_URL;
    delete process.env.REDIS_CACHE_DB;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("default conecta no REDIS_URL sem opção de db", async () => {
    process.env.REDIS_URL = BASE;
    const { cache } = await import("@/lib/cache");
    await cache.get("qualquer");
    expect(h.constructed).toHaveLength(1);
    expect(h.constructed[0].url).toBe(BASE);
    expect(h.constructed[0].options).not.toHaveProperty("db");
  });

  it("REDIS_CACHE_DB conecta no db pedido", async () => {
    process.env.REDIS_URL = `${BASE}/0`;
    process.env.REDIS_CACHE_DB = "5";
    const { cache } = await import("@/lib/cache");
    await cache.get("qualquer");
    expect(h.constructed).toHaveLength(1);
    expect(h.constructed[0].url).toBe(`${BASE}/5`);
    expect(h.constructed[0].options.db).toBe(5);
  });

  it("REDIS_CACHE_URL conecta na instância própria", async () => {
    process.env.REDIS_URL = BASE;
    process.env.REDIS_CACHE_URL = "redis://cache.localhost:6379";
    const { cache } = await import("@/lib/cache");
    await cache.get("qualquer");
    expect(h.constructed).toHaveLength(1);
    expect(h.constructed[0].url).toBe("redis://cache.localhost:6379");
  });
});
