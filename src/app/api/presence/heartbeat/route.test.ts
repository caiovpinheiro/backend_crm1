/**
 * POST /api/presence/heartbeat — presença deduplicada: N abas do mesmo
 * usuário no mesmo deal contam como 1 viewer e cabem em 1 escrita no Redis
 * por ciclo (`PRESENCE_HEARTBEAT_DEDUP_MS`, 20 s); as outras respondem 200
 * com a lista atual, sem escrever. Redis falso compartilhado por 2 "réplicas".
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
    published: 0,
    userId: "u1",
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/realtime-events", () => ({
  publishEntityViewers: () => {
    h.published += 1;
  },
}));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (fn: (s: unknown) => unknown) =>
    fn({ user: { id: h.userId, organizationId: "org1" } }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        name: `Nome ${where.id}`,
        avatarUrl: null,
      }),
    },
  },
}));

import { fakeRedisCalls } from "@/test-setup/fake-cache-redis";

type Route = typeof import("@/app/api/presence/heartbeat/route");

/** Uma "réplica" da API: módulos novos sobre o mesmo Redis falso. */
async function replica(): Promise<Route> {
  vi.resetModules();
  return import("@/app/api/presence/heartbeat/route");
}

function beat(route: Route, entityId = "d1", action?: string) {
  return route.POST(
    new Request("https://api.test/api/presence/heartbeat", {
      method: "POST",
      body: JSON.stringify({ entityType: "deal", entityId, ...(action ? { action } : {}) }),
    }),
  );
}

const writes = () => fakeRedisCalls(h.redis, "MULTI").length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  h.published = 0;
  h.userId = "u1";
  delete process.env.PRESENCE_HEARTBEAT_DEDUP_MS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/presence/heartbeat — dedup por usuário+entidade", () => {
  it("5 abas do mesmo usuário no mesmo deal (2 réplicas): 1 viewer e 1 escrita no ciclo", async () => {
    const a = await replica();
    const b = await replica();
    for (const r of [a, b, a, b, a]) {
      const res = await beat(r);
      expect(res.status).toBe(200);
      expect((await res.json()).viewers.map((v: { userId: string }) => v.userId)).toEqual(["u1"]);
    }
    expect(writes()).toBe(1);
    expect(h.published).toBe(1);

    // Ciclo seguinte: de novo 1 escrita, por mais abas que batam.
    vi.advanceTimersByTime(20_000);
    await beat(a);
    await beat(b);
    await beat(a);
    expect(writes()).toBe(2);
  });

  it("outro usuário e outro deal escrevem à parte", async () => {
    const a = await replica();
    await beat(a, "d1");
    await beat(a, "d2");
    h.userId = "u2";
    const res = await beat(a, "d1");
    expect((await res.json()).viewers.map((v: { userId: string }) => v.userId)).toEqual([
      "u1",
      "u2",
    ]);
    expect(writes()).toBe(3);
  });

  it("leave remove na hora e solta o ciclo: a aba que ficou volta a escrever", async () => {
    const a = await replica();
    await beat(a);
    const left = await beat(a, "d1", "leave");
    expect((await left.json()).viewers).toEqual([]);
    const back = await beat(a);
    expect((await back.json()).viewers.map((v: { userId: string }) => v.userId)).toEqual(["u1"]);
    expect(writes()).toBe(3); // touch, leave, touch
  });

  it("PRESENCE_HEARTBEAT_DEDUP_MS=0 desliga o dedup", async () => {
    process.env.PRESENCE_HEARTBEAT_DEDUP_MS = "0";
    const a = await replica();
    await beat(a);
    await beat(a);
    expect(writes()).toBe(2);
  });

  it("Redis fora: responde 200 pelo fallback em memória (sem quebrar a presença)", async () => {
    const a = await replica();
    h.redis.down = true;
    const res = await beat(a);
    expect(res.status).toBe(200);
    expect((await res.json()).viewers.map((v: { userId: string }) => v.userId)).toEqual(["u1"]);
  });
});
