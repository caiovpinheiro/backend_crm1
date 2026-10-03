/**
 * Presença "quem está vendo" no Redis (E3 / 1.5): duas réplicas da API
 * enxergam a mesma sala. Cada "processo" é uma instância nova do módulo
 * (`vi.resetModules()`) sobre o mesmo Redis falso.
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
    published: [] as Array<{ entityId: string; viewers: Array<{ userId: string }> }>,
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/realtime-events", () => ({
  publishEntityViewers: (p: { entityId: string; viewers: Array<{ userId: string }> }) => {
    h.published.push(p);
  },
}));

import { fakeRedisRaw } from "@/test-setup/fake-cache-redis";

type Presence = typeof import("@/lib/entity-presence");

/** Um "processo" da API: módulo novo, mesmo Redis. */
async function newProcess(): Promise<Presence> {
  vi.resetModules();
  return import("@/lib/entity-presence");
}

const ROOM = { orgId: "org1", entityType: "deal", entityId: "d1" };
const KEY = "presence:viewers:org1:deal:d1";

function user(id: string) {
  return { ...ROOM, userId: id, name: `Nome ${id}`, avatarUrl: null };
}

const ids = (list: Array<{ userId: string }>) => list.map((v) => v.userId);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  h.published.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("entity-presence com Redis (2 processos)", () => {
  it("entrada em réplicas diferentes aparece nas duas; renovação não republica", async () => {
    const a = await newProcess();
    const b = await newProcess();

    expect(ids(await a.touchViewer(user("u1")))).toEqual(["u1"]);
    expect(ids(await b.touchViewer(user("u2")))).toEqual(["u1", "u2"]);
    expect(h.published.map((p) => ids(p.viewers))).toEqual([["u1"], ["u1", "u2"]]);

    // Heartbeat de quem já está, na OUTRA réplica: lista completa, sem broadcast.
    vi.advanceTimersByTime(25_000);
    expect(ids(await b.touchViewer(user("u1")))).toEqual(["u1", "u2"]);
    expect(h.published).toHaveLength(2);
    expect(fakeRedisRaw(h.redis, KEY)).not.toBeNull();
  });

  it("saída numa réplica remove quem entrou pela outra", async () => {
    const a = await newProcess();
    const b = await newProcess();
    await a.touchViewer(user("u1"));
    await a.touchViewer(user("u2"));
    h.published.length = 0;

    expect(ids(await b.removeViewer(ROOM_USER("u1")))).toEqual(["u2"]);
    expect(h.published.map((p) => ids(p.viewers))).toEqual([["u2"]]);

    // Sair de novo não publica nada.
    await a.removeViewer(ROOM_USER("u1"));
    expect(h.published).toHaveLength(1);

    await a.removeViewer(ROOM_USER("u2"));
    expect(fakeRedisRaw(h.redis, KEY)).toBeNull();
  });

  it("expiração: as duas réplicas varrem, só uma publica", async () => {
    const a = await newProcess();
    const b = await newProcess();
    await a.touchViewer(user("u1"));
    await b.touchViewer(user("u2"));
    vi.advanceTimersByTime(60_000);
    await b.touchViewer(user("u2")); // u2 segue vivo
    vi.advanceTimersByTime(40_000); // u1: 100 s sem heartbeat
    h.published.length = 0;

    // Leitura já filtra o vencido, antes de qualquer varredura.
    expect(ids(await a.touchViewer(user("u2")))).toEqual(["u2"]);
    expect(h.published).toHaveLength(0);

    await Promise.all([a.reapEntityViewers(), b.reapEntityViewers()]);
    expect(h.published.map((p) => ids(p.viewers))).toEqual([["u2"]]);

    // Voltar depois de expirar é ENTRADA de novo (broadcast).
    h.published.length = 0;
    await b.touchViewer(user("u1"));
    expect(h.published.map((p) => ids(p.viewers))).toEqual([["u1", "u2"]]);
  });

  it("entrada de quem estava vencido e ainda não varrido conta como entrada", async () => {
    const a = await newProcess();
    const b = await newProcess();
    await a.touchViewer(user("u1"));
    await a.touchViewer(user("u2"));
    vi.advanceTimersByTime(60_000);
    await a.touchViewer(user("u2"));
    vi.advanceTimersByTime(35_000);
    h.published.length = 0;

    await b.touchViewer(user("u1"));
    expect(h.published.map((p) => ids(p.viewers))).toEqual([["u1", "u2"]]);
  });

  it("a sala some do Redis TTL depois do último heartbeat", async () => {
    const a = await newProcess();
    await a.touchViewer(user("u1"));
    vi.advanceTimersByTime(a.ENTITY_PRESENCE_TTL_MS - 1);
    expect(fakeRedisRaw(h.redis, KEY)).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(fakeRedisRaw(h.redis, KEY)).toBeNull();
  });

  it("Redis fora: cai no Map do processo", async () => {
    const a = await newProcess();
    h.redis.down = true;
    expect(ids(await a.touchViewer(user("u1")))).toEqual(["u1"]);
    expect(ids(await a.touchViewer(user("u2")))).toEqual(["u1", "u2"]);
    expect(h.published.map((p) => ids(p.viewers))).toEqual([["u1"], ["u1", "u2"]]);
    expect(ids(await a.removeViewer(ROOM_USER("u1")))).toEqual(["u2"]);
    expect(h.redis.store.size).toBe(0);
  });
});

function ROOM_USER(userId: string) {
  return { ...ROOM, userId };
}
