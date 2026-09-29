/**
 * Cache do board com o Redis no ar (Redis falso em memória, sem rede).
 *
 * - Payload acima de 256 KB gzipado vai pro Redis (teto novo: 1 MB).
 * - Acima de 1 MB fica no fallback em memória, e o `get` lê esse fallback
 *   quando o Redis não tem a chave.
 * - O gzip do `set` é assíncrono (`gzipSync` não roda).
 */
import { randomBytes } from "node:crypto";
import * as zlib from "node:zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  return {
    store: new Map<string, string>(),
    warn: vi.fn(),
  };
});

vi.mock("ioredis", () => {
  function globToRegExp(glob: string): RegExp {
    const body = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${body}$`);
  }
  class FakeRedis {
    status = "ready";
    on() {
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    disconnect() {}
    async get(key: string) {
      return h.store.get(key) ?? null;
    }
    async set(key: string, value: string, ...args: unknown[]) {
      if (args.includes("NX") && h.store.has(key)) return null;
      h.store.set(key, value);
      return "OK";
    }
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (h.store.delete(k)) n++;
      return n;
    }
    async unlink(...keys: string[]) {
      return this.del(...keys);
    }
    async scan(_cursor: string, _match: string, pattern: string) {
      const re = globToRegExp(pattern);
      return ["0", [...h.store.keys()].filter((k) => re.test(k))];
    }
    async eval(_script: string, _n: number, key: string, token: string) {
      if (h.store.get(key) === token) {
        h.store.delete(key);
        return 1;
      }
      return 0;
    }
  }
  return { default: FakeRedis };
});

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, gzipSync: vi.fn(actual.gzipSync) };
});

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: h.warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { cache } from "@/lib/cache";
import { boardDataKey } from "@/lib/cache/keys";
import { metrics } from "@/lib/metrics";

const SKIP_WARNING = "[cache] set pulou Redis — payload acima do limite";

async function boardHits(): Promise<number> {
  const snap = await metrics.cacheHits.get();
  return snap.values.find((v) => v.labels.key === "board")?.value ?? 0;
}

/** base64 de bytes aleatórios: o gzip quase não comprime. */
function incompressiblePayload(bytes: number) {
  return { columns: [{ id: "s1", blob: randomBytes(bytes).toString("base64") }] };
}

function gzippedBytesInRedis(key: string): number {
  const raw = h.store.get(`cache:${key}`);
  if (!raw) return 0;
  expect(raw.startsWith("gz1:")).toBe(true);
  return Buffer.from(raw.slice("gz1:".length), "base64").length;
}

beforeAll(() => {
  expect(process.env.REDIS_URL).toContain("localhost");
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

beforeEach(() => {
  h.store.clear();
  h.warn.mockClear();
  vi.mocked(zlib.gzipSync).mockClear();
});

describe("cache do board com Redis no ar", () => {
  it("payload acima de 256 KB gzipado vai pro Redis e a 2ª carga vem do cache", async () => {
    const key = boardDataKey("org-big", "pipe-1", "variant-a");
    const payload = incompressiblePayload(300_000);
    const loader = vi.fn(async () => payload);
    const hitsBefore = await boardHits();

    const first = await cache.wrap(key, 45, loader);
    expect(first).toEqual(payload);
    expect(gzippedBytesInRedis(key)).toBeGreaterThan(256_000);

    const second = await cache.wrap(key, 45, loader);
    expect(second).toEqual(payload);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await boardHits()).toBe(hitsBefore + 1);
    expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), SKIP_WARNING);
  });

  it("payload acima de 1 MB gzipado fica em memória e a 2ª carga vem do cache", async () => {
    const key = boardDataKey("org-huge", "pipe-1", "variant-a");
    const payload = incompressiblePayload(1_200_000);
    const loader = vi.fn(async () => payload);
    const hitsBefore = await boardHits();

    await cache.wrap(key, 45, loader);
    expect(h.store.has(`cache:${key}`)).toBe(false);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key, maxBytes: 1_000_000 }),
      SKIP_WARNING,
    );

    const second = await cache.wrap(key, 45, loader);
    expect(second).toEqual(payload);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await boardHits()).toBe(hitsBefore + 1);
  });

  it("comprime fora da thread principal (sem gzipSync)", async () => {
    const key = boardDataKey("org-gz", "pipe-1", "variant-a");
    await cache.set(key, incompressiblePayload(50_000), 45);
    expect(gzippedBytesInRedis(key)).toBeGreaterThan(0);
    expect(zlib.gzipSync).not.toHaveBeenCalled();
  });

  it("cópia em memória some quando o valor passa a caber no Redis", async () => {
    const key = boardDataKey("org-shrink", "pipe-1", "variant-a");
    await cache.set(key, incompressiblePayload(1_200_000), 45);
    await cache.set(key, { columns: [] }, 45);
    expect(h.store.has(`cache:${key}`)).toBe(true);

    // Outro processo invalida o board: só o Redis é apagado.
    h.store.delete(`cache:${key}`);
    expect(await cache.get(key)).toBeUndefined();
  });
});
