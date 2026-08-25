/**
 * Cache-aside sem Redis: singleflight e persistencia via memoria.
 */
import { describe, expect, it } from "vitest";

import { cache } from "@/lib/cache";
import { boardDataKey } from "@/lib/cache/keys";

describe("cache.wrap singleflight", () => {
  it("chamadas concorrentes da mesma chave disparam o loader uma vez", async () => {
    const key = `sf:${Date.now()}:${Math.random()}`;
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 40));
      return { loads };
    };
    const [a, b, c] = await Promise.all([
      cache.wrap(key, 30, loader),
      cache.wrap(key, 30, loader),
      cache.wrap(key, 30, loader),
    ]);
    expect(loads).toBe(1);
    expect(a).toEqual({ loads: 1 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe("cache fallback memoria", () => {
  it("grava e le payload grande via wrap/get", async () => {
    const key = `gz:${Date.now()}:${Math.random()}`;
    const payload = { blob: "x".repeat(12_000), n: 7 };
    const stored = await cache.wrap(key, 30, async () => payload);
    expect(stored.n).toBe(7);
    const hit = await cache.get<typeof payload>(key);
    expect(hit?.blob.length).toBe(12_000);
    expect(hit?.n).toBe(7);
  });
});

describe("boardDataKey", () => {
  it("hasheia a variant — chave curta e estavel", () => {
    const variant = JSON.stringify({
      v: {},
      s: "ALL",
      f: { dealCustomFields: [{ name: "atualizado" }] },
      l: { perStage: 50 },
    });
    const a = boardDataKey("org1", "pipe1", variant);
    const b = boardDataKey("org1", "pipe1", variant);
    expect(a).toBe(b);
    expect(a).toMatch(/^board:org1:pipe1:[a-f0-9]{20}$/);
    expect(a.length).toBeLessThan(80);
    expect(a.includes(variant)).toBe(false);
  });
});
