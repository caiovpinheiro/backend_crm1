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
    vi.advanceTimersByTime(100_000);
    await b.touchViewer(user("u2")); // u2 segue vivo
    vi.advanceTimersByTime(60_000); // u1: 160 s sem batida (TTL 150 s)
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
    vi.advanceTimersByTime(100_000);
    await a.touchViewer(user("u2"));
    vi.advanceTimersByTime(55_000); // u1: 155 s sem batida (TTL 150 s)
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

describe("TTL e batida em lote", () => {
  it("TTL do viewer = 2,5 × PRESENCE_BEAT_INTERVAL_MS (150 s no padrão)", async () => {
    const a = await newProcess();
    expect(a.ENTITY_PRESENCE_TTL_MS).toBe(150_000);
    const cfg = await import("@/lib/presence-beat-config");
    expect(cfg.presenceViewerTtlMs({})).toBe(150_000);
    expect(cfg.presenceViewerTtlMs({ PRESENCE_BEAT_INTERVAL_MS: "120000" })).toBe(300_000);
    // Fora da faixa: limitado a 15–300 s.
    expect(cfg.presenceViewerTtlMs({ PRESENCE_BEAT_INTERVAL_MS: "1000" })).toBe(37_500);
    expect(cfg.presenceViewerTtlMs({ PRESENCE_BEAT_INTERVAL_MS: "abc" })).toBe(150_000);
    // Limite por usuário nunca passa do intervalo.
    expect(cfg.presenceBeatMinIntervalMs({})).toBe(30_000);
    expect(
      cfg.presenceBeatMinIntervalMs({
        PRESENCE_BEAT_INTERVAL_MS: "20000",
        PRESENCE_BEAT_MIN_INTERVAL_MS: "45000",
      }),
    ).toBe(20_000);
    // "CRM aberto": max(300 s, 5 × intervalo).
    expect(cfg.systemPresenceStaleMs({})).toBe(300_000);
    expect(cfg.systemPresenceStaleMs({ PRESENCE_BEAT_INTERVAL_MS: "120000" })).toBe(600_000);
  });

  it("viewer vive 150 s sem batida: visível em 149,999 s, some em 150,001 s", async () => {
    const a = await newProcess();
    await a.touchViewer(user("u1"));
    vi.advanceTimersByTime(149_999);
    expect(ids(await a.listViewers(ROOM))).toEqual(["u1"]);
    vi.advanceTimersByTime(2);
    expect(await a.listViewers(ROOM)).toEqual([]);
  });

  it("beatViewers: renova várias, remove as que saíram e grava a lista — um MULTI", async () => {
    const a = await newProcess();
    const d2 = { entityType: "deal", entityId: "d2" };
    const d1 = { entityType: "deal", entityId: "d1" };
    await a.touchViewer({ ...user("u1"), entityId: "d2" });
    h.redis.calls.length = 0;
    h.published.length = 0;
    const out = await a.beatViewers({
      orgId: "org1",
      userId: "u1",
      name: "Nome u1",
      avatarUrl: null,
      touch: [d1, { entityType: "conversation", entityId: "c1" }],
      remove: [d2],
      alsoSet: { key: "lista", value: "[]", ttlMs: 1_000 },
    });
    expect(h.redis.calls).toEqual(["MULTI 11"]);
    expect(Object.keys(out)).toEqual(["deal:d1", "conversation:c1"]);
    expect(ids(out["deal:d1"]!)).toEqual(["u1"]);
    expect(fakeRedisRaw(h.redis, "presence:viewers:org1:deal:d2")).toBeNull();
    expect(fakeRedisRaw(h.redis, "lista")).toBe("[]");
    // Entrada em d1 e c1 + saída de d2 = 3 broadcasts.
    expect(h.published.map((p) => p.entityId).sort()).toEqual(["c1", "d1", "d2"]);

    // Renovação de quem já está: sem broadcast.
    h.published.length = 0;
    await a.beatViewers({
      orgId: "org1",
      userId: "u1",
      name: "Nome u1",
      avatarUrl: null,
      touch: [d1],
      remove: [],
    });
    expect(h.published).toEqual([]);
  });

  it("listViewersMany lê várias entidades num PIPELINE, sem escrever", async () => {
    const a = await newProcess();
    await a.touchViewer(user("u1"));
    h.redis.calls.length = 0;
    const out = await a.listViewersMany("org1", [
      { entityType: "deal", entityId: "d1" },
      { entityType: "deal", entityId: "d9" },
    ]);
    expect(h.redis.calls).toEqual(["PIPELINE 2"]);
    expect(ids(out["deal:d1"]!)).toEqual(["u1"]);
    expect(out["deal:d9"]).toEqual([]);
  });

  it("listViewers só lê (HGETALL) e filtra vencidos", async () => {
    const a = await newProcess();
    await a.touchViewer(user("u1"));
    h.redis.calls.length = 0;
    expect(ids(await a.listViewers(ROOM))).toEqual(["u1"]);
    expect(h.redis.calls.every((c) => c.startsWith("HGETALL"))).toBe(true);
    vi.advanceTimersByTime(a.ENTITY_PRESENCE_TTL_MS + 1);
    expect(await a.listViewers(ROOM)).toEqual([]);
  });
});
