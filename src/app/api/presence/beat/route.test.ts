/**
 * POST /api/presence/beat — batida única por navegador (ping + heartbeat numa
 * chamada), no máximo 1 escrita por usuário a cada 30 s somando abas,
 * navegadores e as rotas antigas. Redis falso em memória compartilhado.
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
    systemPresence: [] as string[],
    user: { id: "u1", organizationId: "org1" as string | null },
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
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (fn: (s: unknown) => unknown) =>
    fn({ user: { ...h.user, isSuperAdmin: false } }),
}));
vi.mock("@/services/system-presence", () => ({
  recordHeartbeatThrottled: async ({ userId }: { userId: string }) => {
    h.systemPresence.push(userId);
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

import { POST as beatPOST } from "@/app/api/presence/beat/route";
import { POST as pingPOST } from "@/app/api/agents/me/ping/route";
import { POST as heartbeatPOST } from "@/app/api/presence/heartbeat/route";
import { reapEntityViewers, resetEntityPresenceForTests } from "@/lib/entity-presence";
import { registry } from "@/lib/metrics";
import { resetPresenceBeatForTests } from "@/lib/presence-beat";
import { fakeRedisCalls, fakeRedisRaw } from "@/test-setup/fake-cache-redis";

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 60 * 60_000;

type Ent = { type: string; id: string };
type Viewer = { userId: string; lastSeen: number };
type BeatJson = {
  ok: boolean;
  deduped?: boolean;
  sessionIdleMs: number;
  nextBeatMs: number;
  retryAfterMs?: number;
  systemOnline?: boolean;
  viewers: Record<string, Viewer[]>;
};

function beat(body: Record<string, unknown>): Promise<Response> {
  return beatPOST(
    new Request("https://api.test/api/presence/beat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function beatJson(body: Record<string, unknown>): Promise<BeatJson> {
  const res = await beat(body);
  expect(res.status).toBe(200);
  return (await res.json()) as BeatJson;
}

const deals = (...ids: string[]): Ent[] => ids.map((id) => ({ type: "deal", id }));
const viewerIds = (list: Array<{ userId: string }> | undefined) =>
  (list ?? []).map((v) => v.userId);
/** Escritas de viewers no Redis (MULTI); leituras deduplicadas são PIPELINE. */
const writes = () => fakeRedisCalls(h.redis, "MULTI").length;

function ping(tabId: string): Promise<Response> {
  return pingPOST(
    new Request("https://api.test/api/agents/me/ping", {
      method: "POST",
      headers: { "x-tab-id": tabId },
    }),
  );
}

function heartbeat(entityId: string): Promise<Response> {
  return heartbeatPOST(
    new Request("https://api.test/api/presence/heartbeat", {
      method: "POST",
      body: JSON.stringify({ entityType: "deal", entityId }),
    }),
  );
}

async function metricValue(route: string, result: string): Promise<number> {
  const m = await registry.getSingleMetric("crm_presence_beats_total")?.get();
  return (
    m?.values.find((v) => v.labels.route === route && v.labels.result === result)?.value ?? 0
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  h.published.length = 0;
  h.systemPresence.length = 0;
  h.user = { id: "u1", organizationId: "org1" };
  resetEntityPresenceForTests();
  resetPresenceBeatForTests();
  delete process.env.PRESENCE_BEAT_INTERVAL_MS;
  delete process.env.PRESENCE_BEAT_MIN_INTERVAL_MS;
  delete process.env.SESSION_IDLE_HOURS;
  delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
  delete process.env.PRESENCE_PING_USER_MAX_PER_MIN;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/presence/beat — contrato", () => {
  it("batida aceita: grava presença do sistema, renova viewers e devolve nextBeatMs", async () => {
    const json = await beatJson({
      tabId: "a1",
      lastInteractionAt: new Date(T0 - 60_000).toISOString(),
      entities: [...deals("d1"), { type: "conversation", id: "c1" }],
    });
    expect(json).toEqual({
      ok: true,
      sessionIdleMs: 12 * HOUR,
      nextBeatMs: 60_000,
      systemOnline: true,
      created: false,
      viewers: {
        "deal:d1": [{ userId: "u1", name: "Nome u1", avatarUrl: null, lastSeen: T0 }],
        "conversation:c1": [{ userId: "u1", name: "Nome u1", avatarUrl: null, lastSeen: T0 }],
      },
    });
    expect(h.systemPresence).toEqual(["u1"]);
    // Uma ida para o limite (EVAL) e uma para todas as escritas (MULTI).
    expect(h.redis.calls.map((c) => c.split(" ")[0])).toEqual(["EVAL", "MULTI"]);
  });

  it("tipos fora da lista e ids inválidos são ignorados; repetidos contam uma vez; teto de 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: "deal", id: `d${i}` }));
    const json = await beatJson({
      entities: [
        { type: "pipeline", id: "p1" },
        { type: "deal", id: "../x" },
        { type: "deal", id: "d0" },
        ...many,
      ],
    });
    expect(Object.keys(json.viewers)).toHaveLength(20);
    expect(json.viewers["deal:d0"]).toBeDefined();
    expect(json.viewers["pipeline:p1"]).toBeUndefined();
  });

  it("corpo vazio ou inválido: batida sem entidades (presença do sistema só)", async () => {
    const res = await beatPOST(
      new Request("https://api.test/api/presence/beat", { method: "POST", body: "{x" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).viewers).toEqual({});
    expect(h.systemPresence).toEqual(["u1"]);
  });

  it("super-admin sem org: 200 sem escrever nada", async () => {
    h.user = { id: "sa", organizationId: null };
    expect(await beatJson({ entities: deals("d1") })).toEqual({
      ok: true,
      sessionIdleMs: 12 * HOUR,
      nextBeatMs: 60_000,
      viewers: {},
    });
    expect(h.redis.calls).toEqual([]);
  });

  it("PRESENCE_BEAT_INTERVAL_MS muda nextBeatMs", async () => {
    process.env.PRESENCE_BEAT_INTERVAL_MS = "90000";
    expect((await beatJson({})).nextBeatMs).toBe(90_000);
  });
});

describe("POST /api/presence/beat — 1 escrita por usuário a cada 30 s", () => {
  it("3 abas de 2 navegadores do mesmo usuário em 60 s → 1 escrita", async () => {
    // Navegador A: aba líder a1 (batida) + a2 (batida extra, ex.: foco).
    // Navegador B: aba líder b1. Cada líder bate a cada 60 s.
    const timeline: Array<[number, string, string, Ent[]]> = [
      [0, "navA", "a1", deals("d1")],
      [10_000, "navA", "a2", deals("d1")],
      [20_000, "navB", "b1", deals("d2")],
    ];
    const results: boolean[] = [];
    for (const [at, clientId, tabId, entities] of timeline) {
      vi.setSystemTime(T0 + at);
      results.push((await beatJson({ clientId, tabId, entities })).deduped === true);
    }
    expect(results).toEqual([false, true, true]);
    expect(writes()).toBe(1);
    expect(h.systemPresence).toHaveLength(1);

    // Ciclo seguinte (60–120 s): de novo 1 escrita.
    for (const [at, clientId, tabId, entities] of timeline) {
      vi.setSystemTime(T0 + 60_000 + at);
      await beatJson({ clientId, tabId, entities });
    }
    expect(writes()).toBe(2);
    expect(h.systemPresence).toHaveLength(2);
  });

  it("deduplicada: 200 com deduped, retryAfterMs e viewers lidos do Redis, sem escrever", async () => {
    h.user = { id: "u2", organizationId: "org1" };
    await beatJson({ entities: deals("d1") });
    h.user = { id: "u1", organizationId: "org1" };
    await beatJson({ entities: deals("d1") });
    h.redis.calls.length = 0;

    vi.setSystemTime(T0 + 12_000);
    const json = await beatJson({ entities: deals("d1", "d9") });
    expect(json.deduped).toBe(true);
    expect(json.nextBeatMs).toBe(60_000);
    expect(json.retryAfterMs).toBe(18_000);
    expect(viewerIds(json.viewers["deal:d1"])).toEqual(["u1", "u2"]);
    expect(json.viewers["deal:d9"]).toEqual([]);
    // Só o EVAL do limite e um PIPELINE de leitura.
    expect(h.redis.calls.map((c) => c.split(" ")[0])).toEqual(["EVAL", "PIPELINE"]);
    expect(writes()).toBe(0);
    expect(h.systemPresence).toEqual(["u2", "u1"]);
  });

  it("métricas crm_presence_beats_total{route,result}", async () => {
    const w0 = await metricValue("beat", "written");
    const d0 = await metricValue("beat", "deduped");
    await beatJson({});
    await beatJson({});
    await beatJson({});
    expect((await metricValue("beat", "written")) - w0).toBe(1);
    expect((await metricValue("beat", "deduped")) - d0).toBe(2);
    const text = await registry.metrics();
    expect(text).toContain('crm_presence_beats_total{route="beat",result="written"');
  });
});

describe("POST /api/presence/beat — entidades renovadas e removidas", () => {
  it("renova as listadas e REMOVE o usuário das que saíram da lista", async () => {
    await beatJson({ entities: deals("d1", "d2") });
    h.user = { id: "u2", organizationId: "org1" };
    await beatJson({ entities: deals("d2") });
    h.user = { id: "u1", organizationId: "org1" };
    h.published.length = 0;

    vi.setSystemTime(T0 + 60_000);
    const json = await beatJson({ entities: deals("d1", "d3") });
    expect(json.deduped).toBeUndefined();
    // d1 renovado (lastSeen novo), d3 entrou.
    expect(json.viewers["deal:d1"]).toEqual([
      { userId: "u1", name: "Nome u1", avatarUrl: null, lastSeen: T0 + 60_000 },
    ]);
    expect(viewerIds(json.viewers["deal:d3"])).toEqual(["u1"]);
    // d2 saiu da lista: u1 removido na hora, u2 continua.
    expect(Object.keys(JSON.parse(fakeRedisRaw(h.redis, "presence:viewers:org1:deal:d2")!))).toEqual([
      "u2",
    ]);
    // Viewers só das entidades enviadas.
    expect(Object.keys(json.viewers).sort()).toEqual(["deal:d1", "deal:d3"]);
    // Broadcast: entrada em d3 e saída de d2 (renovação de d1 não publica).
    expect(h.published.map((p) => [p.entityId, viewerIds(p.viewers)])).toEqual([
      ["d3", ["u1"]],
      ["d2", ["u2"]],
    ]);
  });

  it("lista vazia remove o usuário de tudo o que estava aberto", async () => {
    await beatJson({ entities: deals("d1") });
    vi.setSystemTime(T0 + 60_000);
    await beatJson({ entities: [] });
    expect(fakeRedisRaw(h.redis, "presence:viewers:org1:deal:d1")).toBeNull();
  });

  it("com clientId a remoção vale só para o mesmo navegador", async () => {
    await beatJson({ clientId: "navA", entities: deals("d1") });
    vi.setSystemTime(T0 + 60_000);
    // Navegador B não conhece d1: não remove o que o A abriu.
    await beatJson({ clientId: "navB", entities: deals("d2") });
    const d1 = JSON.parse(fakeRedisRaw(h.redis, "presence:viewers:org1:deal:d1")!);
    expect(Object.keys(d1)).toEqual(["u1"]);
    vi.setSystemTime(T0 + 120_000);
    // O próprio A fechou d1 → remove.
    await beatJson({ clientId: "navA", entities: [] });
    expect(fakeRedisRaw(h.redis, "presence:viewers:org1:deal:d1")).toBeNull();
  });

  it("TTL dos viewers 150 s: some 150 s depois da última batida (aba fechada sem aviso)", async () => {
    await beatJson({ entities: deals("d1") });
    h.user = { id: "u2", organizationId: "org1" };
    vi.setSystemTime(T0 + 149_999);
    expect(viewerIds((await beatJson({ entities: deals("d1") })).viewers["deal:d1"])).toEqual([
      "u1",
      "u2",
    ]);
    vi.setSystemTime(T0 + 150_001);
    h.published.length = 0;
    await reapEntityViewers();
    expect(h.published.map((p) => viewerIds(p.viewers))).toEqual([["u2"]]);
  });
});

describe("POST /api/presence/beat — inatividade (mesma regra do ping)", () => {
  it("lastInteractionAt há 13 h → 401 SESSION_REVOKED reason idle, sem escrever e sem gastar a batida", async () => {
    const res = await beat({
      lastInteractionAt: new Date(T0 - 13 * HOUR).toISOString(),
      entities: deals("d1"),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    const pingRes = await pingPOST(
      new Request("https://api.test/api/agents/me/ping", {
        method: "POST",
        headers: { "x-tab-id": "a1", "content-type": "application/json" },
        body: JSON.stringify({ lastInteractionAt: T0 - 13 * HOUR }),
      }),
    );
    expect(pingRes.status).toBe(401);
    expect(body).toEqual(await pingRes.json());
    expect(body).toEqual({
      message: "Sessão expirada. Entre novamente.",
      code: "SESSION_REVOKED",
      reason: "idle",
    });
    expect([...h.redis.store.keys()]).toEqual([]);
    expect(h.systemPresence).toEqual([]);
    // A batida seguinte (usuário voltou) é aceita.
    expect((await beatJson({ lastInteractionAt: T0 })).deduped).toBeUndefined();
  });

  it("SESSION_IDLE_HOURS=0.05: 4 min → 401; 2 min → 200 com sessionIdleMs 180000", async () => {
    process.env.SESSION_IDLE_HOURS = "0.05";
    expect((await beat({ lastInteractionAt: T0 - 4 * 60_000 })).status).toBe(401);
    expect((await beatJson({ lastInteractionAt: T0 - 2 * 60_000 })).sessionIdleMs).toBe(180_000);
  });
});

describe("compatibilidade: ping e heartbeat antigos dividem o mesmo limite", () => {
  it("beat → ping e heartbeat em < 30 s respondem 200 deduplicado; depois de 30 s o heartbeat grava", async () => {
    await beatJson({ entities: deals("d1") });
    vi.setSystemTime(T0 + 5_000);
    expect(await (await ping("t1")).json()).toMatchObject({ ok: true, deduped: true });
    vi.setSystemTime(T0 + 10_000);
    const hb = await (await heartbeat("d1")).json();
    expect(hb.deduped).toBe(true);
    expect(viewerIds(hb.viewers)).toEqual(["u1"]);
    expect(h.systemPresence).toEqual(["u1"]);
    expect(writes()).toBe(1);

    vi.setSystemTime(T0 + 30_000);
    expect((await (await heartbeat("d1")).json()).deduped).toBeUndefined();
    expect(writes()).toBe(2);
    // O heartbeat aceito também grava a presença de uso.
    expect(h.systemPresence).toEqual(["u1", "u1"]);
    // E agora é a batida nova que fica para depois.
    vi.setSystemTime(T0 + 40_000);
    expect((await beatJson({ entities: deals("d1") })).deduped).toBe(true);
    expect(await metricValue("heartbeat", "written")).toBeGreaterThanOrEqual(1);
    expect(await metricValue("ping", "deduped")).toBeGreaterThanOrEqual(1);
  });
});

/** Gerador determinístico (LCG) para a simulação. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("simulação da org: 20 usuários × 2 abas por 10 min", () => {
  it("frontend novo (cada aba batendo a cada 60 s ± 3 s): ≤ 30 escritas/min; ninguém fica sem presença", async () => {
    const rand = rng(42);
    const events: Array<{ at: number; user: string; tab: string }> = [];
    for (let u = 0; u < 20; u++) {
      for (let t = 0; t < 2; t++) {
        // Pior caso: as DUAS abas batem (sem eleição de líder).
        let at = Math.floor(rand() * 60_000);
        while (at < 10 * 60_000) {
          events.push({ at, user: `u${u}`, tab: `t${t}` });
          at += 60_000 + Math.floor((rand() - 0.5) * 6_000);
        }
      }
    }
    events.sort((a, b) => a.at - b.at);

    const written = new Map<string, number[]>();
    let total = 0;
    for (const e of events) {
      vi.setSystemTime(T0 + e.at);
      h.user = { id: e.user, organizationId: "org1" };
      const json = await beatJson({ tabId: e.tab, entities: deals(`deal-${e.user}`) });
      if (json.deduped) continue;
      total++;
      written.set(e.user, [...(written.get(e.user) ?? []), e.at]);
    }

    const perMin = total / 10;
    expect(events.length).toBeGreaterThanOrEqual(380); // ~10 batidas por aba
    expect(perMin).toBeLessThanOrEqual(30);
    // Hoje (ping + heartbeat sem limite único) eram ~59/min nessa org.
    for (const [, times] of written) {
      for (let i = 1; i < times.length; i++) {
        // Gap entre escritas < TTL do viewer (150 s) e < "CRM aberto" (300 s).
        expect(times[i]! - times[i - 1]!).toBeLessThan(150_000);
        // Nunca 2 escritas do mesmo usuário em < 30 s.
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(30_000);
      }
    }
    expect(written.size).toBe(20);
  });

  it("frontend antigo (ping 90 s + heartbeat 25 s): ≤ 2 escritas/min por usuário, viewer e presença sem buraco", async () => {
    const events: Array<{ at: number; user: string; kind: "ping" | "hb" }> = [];
    const rand = rng(7);
    for (let u = 0; u < 20; u++) {
      const off = Math.floor(rand() * 25_000);
      for (let at = off; at < 10 * 60_000; at += 25_000) events.push({ at, user: `u${u}`, kind: "hb" });
      const offP = Math.floor(rand() * 90_000);
      for (let at = offP; at < 10 * 60_000; at += 90_000) events.push({ at, user: `u${u}`, kind: "ping" });
    }
    events.sort((a, b) => a.at - b.at);

    const viewerWrites = new Map<string, number[]>();
    const anyWrites = new Map<string, number[]>();
    let total = 0;
    for (const e of events) {
      vi.setSystemTime(T0 + e.at);
      h.user = { id: e.user, organizationId: "org1" };
      const res = e.kind === "hb" ? await heartbeat(`deal-${e.user}`) : await ping(`tab-${e.user}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      if (json.deduped) continue;
      total++;
      anyWrites.set(e.user, [...(anyWrites.get(e.user) ?? []), e.at]);
      if (e.kind === "hb") viewerWrites.set(e.user, [...(viewerWrites.get(e.user) ?? []), e.at]);
    }
    // Teto absoluto: 2 por usuário por minuto (1 a cada 30 s).
    expect(total / 10).toBeLessThanOrEqual(40);
    for (const times of anyWrites.values()) {
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(30_000);
        expect(times[i]! - times[i - 1]!).toBeLessThan(300_000);
      }
    }
    for (const times of viewerWrites.values()) {
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeLessThan(150_000);
      }
    }
  });
});
