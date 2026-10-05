/**
 * `cache.wrapText` / `getText` / `setText` (B3): texto JSON guardado e
 * devolvido como está, com o mesmo formato no Redis de `set` (texto ou
 * `gz1:` + base64) e o mesmo singleflight/lock do `wrap`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { cache } from "@/lib/cache";
import { fakeRedisRaw } from "@/test-setup/fake-cache-redis";

beforeEach(() => {
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cache de texto", () => {
  it("erro roda o loader uma vez; acerto devolve o mesmo texto sem JSON.parse", async () => {
    const loader = vi.fn(async () => JSON.stringify([{ id: "s1", deals: [] }]));
    const first = await cache.wrapText("board:t1", 45, loader);
    expect(first).toEqual({ text: '[{"id":"s1","deals":[]}]', source: "miss" });

    const parse = vi.spyOn(JSON, "parse");
    const second = await cache.wrapText("board:t1", 45, loader);
    expect(second).toEqual({ text: first.text, source: "hit" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
  });

  it("texto grande vai gzipado (mesmo formato do `set`) e volta igual", async () => {
    const big = JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ id: i, t: "x".repeat(20) })));
    await cache.setText("board:big", big, 45);
    expect(fakeRedisRaw(h.redis, "cache:board:big")?.startsWith("gz1:")).toBe(true);
    expect(await cache.getText("board:big")).toBe(big);
    // `get` (objeto) lê o mesmo valor.
    expect(await cache.get("board:big")).toEqual(JSON.parse(big));
  });

  it("chamadas simultâneas dividem um loader (singleflight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const loader = vi.fn(async () => {
      await gate;
      return "[1]";
    });
    const a = cache.wrapText("board:sf", 45, loader);
    const b = cache.wrapText("board:sf", 45, loader);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect([ra.source, rb.source].sort()).toEqual(["miss", "shared"]);
    expect(ra.text).toBe("[1]");
    expect(rb.text).toBe("[1]");
  });

  it("Redis fora: guarda e lê no fallback em memória", async () => {
    h.redis.down = true;
    const loader = vi.fn(async () => "[2]");
    expect((await cache.wrapText("board:down", 45, loader)).source).toBe("miss");
    expect((await cache.wrapText("board:down", 45, loader)).source).toBe("hit");
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
