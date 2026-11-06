/**
 * POST /api/presence/join — sinal imediato de entrada/saída do negócio.
 * Entrada aparece na hora para quem já está no negócio (sem esperar a
 * batida de 1 min); repetição em menos de 5 s só lê; saída tira na hora.
 * Redis falso compartilhado por 2 "réplicas".
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
    published: [] as Array<{ viewers: Array<{ userId: string }>; audience?: string[] }>,
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
  publishEntityViewers: (
    p: { viewers: Array<{ userId: string }> },
    opts?: { audienceUserIds?: string[] },
  ) => {
    h.published.push({ viewers: p.viewers, audience: opts?.audienceUserIds });
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

type Route = typeof import("@/app/api/presence/join/route");

async function replica(): Promise<Route> {
  vi.resetModules();
  return import("@/app/api/presence/join/route");
}

async function send(route: Route, userId: string, body: Record<string, unknown>) {
  h.userId = userId;
  const res = await route.POST(
    new Request("https://api.test/api/presence/join", {
      method: "POST",
      body: JSON.stringify({ entityType: "deal", entityId: "d1", ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { viewers: Array<{ userId: string }>; throttled?: boolean } };
}
const ids = (v: Array<{ userId: string }>) => v.map((x) => x.userId).sort();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.published.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("POST /api/presence/join", () => {
  it("segunda pessoa entra: as duas aparecem na hora e o aviso vai só para quem está no negócio", async () => {
    const a = await replica();
    const b = await replica();
    expect(ids((await send(a, "tamires", {})).json.viewers)).toEqual(["tamires"]);
    const second = await send(b, "hugo", {});
    expect(ids(second.json.viewers)).toEqual(["hugo", "tamires"]);
    const last = h.published.at(-1)!;
    expect(ids(last.viewers)).toEqual(["hugo", "tamires"]);
    expect(last.audience?.sort()).toEqual(["hugo", "tamires"]);
  });

  it("abrir de novo em menos de 5 s só lê (sem nova escrita nem aviso)", async () => {
    const a = await replica();
    await send(a, "tamires", {});
    const published = h.published.length;
    const again = await send(a, "tamires", {});
    expect(again.json.throttled).toBe(true);
    expect(ids(again.json.viewers)).toEqual(["tamires"]);
    expect(h.published.length).toBe(published);
    vi.advanceTimersByTime(5_001);
    expect((await send(a, "tamires", {})).json.throttled).toBeUndefined();
  });

  it("saída tira na hora e avisa quem ficou", async () => {
    const a = await replica();
    await send(a, "tamires", {});
    await send(a, "hugo", {});
    const out = await send(a, "hugo", { action: "leave" });
    expect(ids(out.json.viewers)).toEqual(["tamires"]);
    expect(h.published.at(-1)!.audience).toEqual(["tamires"]);
  });

  it("entidade fora da lista ou id inválido: 400", async () => {
    const a = await replica();
    expect((await send(a, "tamires", { entityType: "contact" })).status).toBe(400);
    expect((await send(a, "tamires", { entityId: "../x" })).status).toBe(400);
  });
});
