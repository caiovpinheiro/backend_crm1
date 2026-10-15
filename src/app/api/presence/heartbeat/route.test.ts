/**
 * POST /api/presence/heartbeat (frontend antigo) — obedece o limite único da
 * batida: 1 escrita por USUÁRIO a cada `PRESENCE_BEAT_MIN_INTERVAL_MS` (30 s),
 * somando abas, deals e as outras rotas; as demais respondem 200 com a lista
 * atual e `deduped: true`, sem escrever. Redis falso compartilhado por 2
 * "réplicas".
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
    systemPresence: 0,
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
vi.mock("@/services/system-presence", () => ({
  recordHeartbeatThrottled: async () => {
    h.systemPresence += 1;
    return { created: false, written: true };
  },
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
  h.systemPresence = 0;
  delete process.env.PRESENCE_BEAT_MIN_INTERVAL_MS;
  // Estes testes medem os limites (aba, usuário, 30 s): o no-op de 45 s
  // (204) tem testes próprios em `presence/beat/route.test.ts`.
  process.env.PRESENCE_BEAT_NOOP_WINDOW_MS = "0";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PRESENCE_BEAT_NOOP_WINDOW_MS;
});

describe("POST /api/presence/heartbeat — limite único por usuário", () => {
  it("5 abas do mesmo usuário no mesmo deal (2 réplicas): 1 viewer e 1 escrita a cada 30 s", async () => {
    const a = await replica();
    const b = await replica();
    const deduped: boolean[] = [];
    for (const r of [a, b, a, b, a]) {
      const res = await beat(r);
      expect(res.status).toBe(200);
      const json = await res.json();
      deduped.push(json.deduped === true);
      expect(json.viewers.map((v: { userId: string }) => v.userId)).toEqual(["u1"]);
    }
    expect(deduped).toEqual([false, true, true, true, true]);
    expect(writes()).toBe(1);
    expect(h.published).toBe(1);
    // A batida aceita também grava a presença de uso ("CRM aberto").
    expect(h.systemPresence).toBe(1);

    vi.advanceTimersByTime(29_999);
    await beat(a);
    expect(writes()).toBe(1);
    vi.advanceTimersByTime(1);
    await beat(a);
    await beat(b);
    await beat(a);
    expect(writes()).toBe(2);
  });

  it("outro deal do mesmo usuário divide o limite; outro usuário escreve à parte", async () => {
    const a = await replica();
    await beat(a, "d1");
    const other = await beat(a, "d2");
    expect(await other.json()).toEqual({ viewers: [], deduped: true });
    h.userId = "u2";
    const res = await beat(a, "d1");
    expect((await res.json()).viewers.map((v: { userId: string }) => v.userId)).toEqual([
      "u1",
      "u2",
    ]);
    expect(writes()).toBe(2);
  });

  it("leave remove na hora sem passar pelo limite (e sem gastar a batida)", async () => {
    const a = await replica();
    await beat(a);
    const left = await beat(a, "d1", "leave");
    expect((await left.json()).viewers).toEqual([]);
    // A aba que ficou no deal volta na próxima batida aceita (≤ 30 s).
    const back = await beat(a);
    expect(await back.json()).toEqual({ viewers: [], deduped: true });
    vi.advanceTimersByTime(30_000);
    const later = await beat(a);
    expect((await later.json()).viewers.map((v: { userId: string }) => v.userId)).toEqual(["u1"]);
    expect(writes()).toBe(3); // touch, leave, touch
  });

  it("PRESENCE_BEAT_MIN_INTERVAL_MS muda o limite", async () => {
    process.env.PRESENCE_BEAT_MIN_INTERVAL_MS = "5000";
    const a = await replica();
    await beat(a);
    await beat(a);
    expect(writes()).toBe(1);
    vi.advanceTimersByTime(5_000);
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
