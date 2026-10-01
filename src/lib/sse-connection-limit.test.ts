/**
 * Teto de conexões SSE (SSE-2) com Redis falso em memória e timers falsos.
 *
 * - Por usuário: a (N+1)-ésima conexão encerra a mais antiga (onEvict) e
 *   entra; o encerramento é publicado para as outras réplicas e também
 *   chega por pub/sub.
 * - Por organização: ao exceder, `org_limit` com Retry-After e métrica.
 * - Entrada sem heartbeat expira após o TTL; heartbeat renova; release remove.
 * - Sem REDIS_URL, ou com erro no Redis, não limita e loga (1×/min).
 * - 0 desliga o teto; env inválida cai no default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  return {
    /** chave → (membro → score) */
    zsets: new Map<string, Map<string, number>>(),
    /** chave → expira em (ms) */
    expires: new Map<string, number>(),
    subscribers: new Set<{ channels: Set<string>; emit: (ch: string, msg: string) => void }>(),
    published: [] as { channel: string; message: string }[],
    failNext: null as null | string,
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock("ioredis", () => {
  class FakeRedis {
    status = "ready";
    private channels = new Set<string>();
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    on(event: string, fn: (...a: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    async connect() {}
    disconnect() {}
    private zset(key: string): Map<string, number> {
      const exp = h.expires.get(key);
      if (exp !== undefined && exp <= Date.now()) {
        h.zsets.delete(key);
        h.expires.delete(key);
      }
      let z = h.zsets.get(key);
      if (!z) {
        z = new Map();
        h.zsets.set(key, z);
      }
      return z;
    }
    private maybeFail(cmd: string) {
      if (h.failNext && h.failNext === cmd) throw new Error(`fake redis: ${cmd} falhou`);
    }
    async zadd(key: string, score: number, member: string) {
      this.maybeFail("zadd");
      const z = this.zset(key);
      const isNew = !z.has(member);
      z.set(member, score);
      return isNew ? 1 : 0;
    }
    async zremrangebyscore(key: string, _min: string, max: string) {
      this.maybeFail("zremrangebyscore");
      const z = this.zset(key);
      const limit = Number(max.replace("(", ""));
      let n = 0;
      for (const [m, s] of [...z]) {
        if (s < limit) {
          z.delete(m);
          n++;
        }
      }
      return n;
    }
    async zcard(key: string) {
      this.maybeFail("zcard");
      return this.zset(key).size;
    }
    async zrange(key: string, _start: number, _stop: number) {
      this.maybeFail("zrange");
      return [...this.zset(key).keys()];
    }
    async zrem(key: string, member: string) {
      this.maybeFail("zrem");
      return this.zset(key).delete(member) ? 1 : 0;
    }
    async pexpire(key: string, ms: number) {
      this.maybeFail("pexpire");
      h.expires.set(key, Date.now() + ms);
      return 1;
    }
    async publish(channel: string, message: string) {
      this.maybeFail("publish");
      h.published.push({ channel, message });
      for (const sub of h.subscribers) {
        if (sub.channels.has(channel)) sub.emit(channel, message);
      }
      return 1;
    }
    async subscribe(channel: string) {
      this.channels.add(channel);
      h.subscribers.add({
        channels: this.channels,
        emit: (ch, msg) => {
          for (const fn of this.handlers.get("message") ?? []) fn(ch, msg);
        },
      });
      return 1;
    }
  }
  return { default: FakeRedis };
});

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: h.warn, info: h.info, debug: vi.fn(), error: vi.fn() }),
}));

import { metrics } from "@/lib/metrics";
import {
  __resetSseConnectionLimitForTests,
  acquireSseConnection,
  DEFAULT_SSE_MAX_PER_ORG,
  DEFAULT_SSE_MAX_PER_USER,
  getSseMaxPerOrg,
  getSseMaxPerUser,
  SSE_CONNECTION_TTL_MS,
  SSE_HEARTBEAT_MS,
  type SseAcquireResult,
} from "@/lib/sse-connection-limit";

async function rejected(reason: string): Promise<number> {
  const snap = await metrics.sse.connectionsRejected.get();
  return snap.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

async function flush() {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
}

function okSlot(r: SseAcquireResult) {
  if (!r.ok) throw new Error(`esperava ok, veio ${r.reason}`);
  return r.slot;
}

async function open(userId: string, orgId: string | null = "org1") {
  const onEvict = vi.fn();
  const r = await acquireSseConnection({ userId, organizationId: orgId, onEvict });
  // Ordena startedAt entre conexões abertas em sequência.
  vi.advanceTimersByTime(1);
  return { r, onEvict };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSseConnectionLimitForTests();
  h.zsets.clear();
  h.expires.clear();
  h.subscribers.clear();
  h.published.length = 0;
  h.failNext = null;
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.SSE_MAX_PER_USER;
  delete process.env.SSE_MAX_PER_ORG;
  // Só o relógio: score/TTL usam Date.now(); setImmediate do flush() fica real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  metrics.sse.connectionsRejected.reset();
});

afterEach(() => {
  vi.useRealTimers();
  __resetSseConnectionLimitForTests();
  delete process.env.REDIS_URL;
});

describe("envs", () => {
  it("defaults 6/200; inteiro válido vale; 0 é 'desligado'; inválido cai no default", () => {
    expect(getSseMaxPerUser()).toBe(DEFAULT_SSE_MAX_PER_USER);
    expect(getSseMaxPerOrg()).toBe(DEFAULT_SSE_MAX_PER_ORG);
    process.env.SSE_MAX_PER_USER = "3";
    process.env.SSE_MAX_PER_ORG = "0";
    expect(getSseMaxPerUser()).toBe(3);
    expect(getSseMaxPerOrg()).toBe(0);
    process.env.SSE_MAX_PER_USER = "abc";
    process.env.SSE_MAX_PER_ORG = "-1";
    expect(getSseMaxPerUser()).toBe(DEFAULT_SSE_MAX_PER_USER);
    expect(getSseMaxPerOrg()).toBe(DEFAULT_SSE_MAX_PER_ORG);
    process.env.SSE_MAX_PER_USER = "";
    expect(getSseMaxPerUser()).toBe(DEFAULT_SSE_MAX_PER_USER);
  });

  it("TTL da entrada é maior que o heartbeat (folga para jitter)", () => {
    expect(SSE_CONNECTION_TTL_MS).toBeGreaterThan(SSE_HEARTBEAT_MS);
  });
});

describe("teto por usuário", () => {
  it("a 7ª conexão encerra a mais antiga (onEvict), publica e entra", async () => {
    const conns = [];
    for (let i = 0; i < 6; i++) conns.push(await open("u1"));
    expect(conns.every((c) => c.r.ok)).toBe(true);
    expect(h.zsets.get("sse:conn:u:u1")?.size).toBe(6);

    const seventh = await open("u1");
    expect(seventh.r.ok).toBe(true);
    await flush();
    expect(conns[0].onEvict).toHaveBeenCalledTimes(1);
    for (const c of conns.slice(1)) expect(c.onEvict).not.toHaveBeenCalled();
    expect(seventh.onEvict).not.toHaveBeenCalled();
    expect(h.zsets.get("sse:conn:u:u1")?.size).toBe(6);
    expect(h.zsets.get("sse:conn:o:org1")?.size).toBe(6);

    const evictedId = okSlot(conns[0].r).connId;
    expect(h.published).toEqual([
      { channel: "crm:sse:evict", message: JSON.stringify({ connId: evictedId }) },
    ]);
    expect(await rejected("user_limit_evicted")).toBe(1);
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", evictedConnId: evictedId, limit: 6 }),
      expect.stringMatching(/mais antiga/),
    );
    // Evicção de novo do mesmo id (pub/sub da própria réplica) é no-op.
    expect(conns[0].onEvict).toHaveBeenCalledTimes(1);
  });

  it("eviction vinda de outra réplica (pub/sub) encerra a conexão local", async () => {
    const a = await open("u1");
    await flush();
    const connId = okSlot(a.r).connId;
    for (const sub of h.subscribers) sub.emit("crm:sse:evict", JSON.stringify({ connId }));
    expect(a.onEvict).toHaveBeenCalledTimes(1);
    // id desconhecido / payload inválido: ignorados.
    for (const sub of h.subscribers) {
      sub.emit("crm:sse:evict", JSON.stringify({ connId: "nope" }));
      sub.emit("crm:sse:evict", "{not json");
    }
    expect(a.onEvict).toHaveBeenCalledTimes(1);
  });

  it("limites são por usuário: outro usuário não derruba ninguém", async () => {
    process.env.SSE_MAX_PER_USER = "1";
    const a = await open("u1");
    const b = await open("u2");
    expect(b.r.ok).toBe(true);
    expect(a.onEvict).not.toHaveBeenCalled();
    expect(h.zsets.get("sse:conn:o:org1")?.size).toBe(2);
  });

  it("SSE_MAX_PER_USER=0 desliga o teto por usuário", async () => {
    process.env.SSE_MAX_PER_USER = "0";
    const conns = [];
    for (let i = 0; i < 10; i++) conns.push(await open("u1"));
    expect(conns.every((c) => c.r.ok && !c.onEvict.mock.calls.length)).toBe(true);
    // A org continua contando.
    expect(h.zsets.get("sse:conn:o:org1")?.size).toBe(10);
  });
});

describe("teto por organização", () => {
  it("ao exceder: org_limit com Retry-After, métrica e warn; ninguém é derrubado", async () => {
    process.env.SSE_MAX_PER_ORG = "2";
    const a = await open("u1");
    const b = await open("u2");
    const c = await open("u3");
    expect(c.r).toEqual({
      ok: false,
      reason: "org_limit",
      retryAfterSec: Math.ceil(SSE_CONNECTION_TTL_MS / 1000),
      count: 2,
      limit: 2,
    });
    expect(a.onEvict).not.toHaveBeenCalled();
    expect(b.onEvict).not.toHaveBeenCalled();
    expect(h.zsets.get("sse:conn:o:org1")?.size).toBe(2);
    expect(await rejected("org_limit")).toBe(1);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", count: 2, limit: 2 }),
      expect.stringMatching(/429/),
    );
  });

  it("super-admin sem org só conta no próprio usuário", async () => {
    process.env.SSE_MAX_PER_ORG = "1";
    const a = await open("sa", null);
    const b = await open("sa", null);
    expect(a.r.ok && b.r.ok).toBe(true);
    expect(h.zsets.has("sse:conn:o:null")).toBe(false);
    expect(h.zsets.get("sse:conn:u:sa")?.size).toBe(2);
  });
});

describe("ciclo de vida da entrada", () => {
  it("sem heartbeat a entrada expira após o TTL e libera a vaga sem evicção", async () => {
    process.env.SSE_MAX_PER_USER = "1";
    const a = await open("u1");
    vi.advanceTimersByTime(SSE_CONNECTION_TTL_MS + 1);
    const b = await open("u1");
    expect(b.r.ok).toBe(true);
    expect(a.onEvict).not.toHaveBeenCalled();
    expect(h.zsets.get("sse:conn:u:u1")?.size).toBe(1);
  });

  it("heartbeat renova: a conexão viva segue contando e é a evictada ao exceder", async () => {
    process.env.SSE_MAX_PER_USER = "1";
    const a = await open("u1");
    const slotA = okSlot(a.r);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(SSE_HEARTBEAT_MS);
      await slotA.heartbeat();
    }
    const b = await open("u1");
    expect(b.r.ok).toBe(true);
    await flush();
    expect(a.onEvict).toHaveBeenCalledTimes(1);
  });

  it("release remove a entrada (idempotente) e a vaga volta sem evicção", async () => {
    process.env.SSE_MAX_PER_USER = "1";
    const a = await open("u1");
    const slotA = okSlot(a.r);
    await slotA.release();
    await slotA.release();
    expect(h.zsets.get("sse:conn:u:u1")?.size).toBe(0);
    expect(h.zsets.get("sse:conn:o:org1")?.size).toBe(0);
    const b = await open("u1");
    expect(b.r.ok).toBe(true);
    expect(a.onEvict).not.toHaveBeenCalled();
    // Heartbeat depois do release não ressuscita a entrada.
    await slotA.heartbeat();
    expect(h.zsets.get("sse:conn:u:u1")?.size).toBe(1);
  });
});

describe("falhas", () => {
  it("sem REDIS_URL: não limita e informa uma vez", async () => {
    delete process.env.REDIS_URL;
    __resetSseConnectionLimitForTests();
    process.env.SSE_MAX_PER_USER = "1";
    for (let i = 0; i < 3; i++) {
      const c = await open("u1");
      expect(c.r.ok).toBe(true);
      expect(c.onEvict).not.toHaveBeenCalled();
    }
    expect(h.zsets.size).toBe(0);
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.info.mock.calls[0][0]).toMatch(/REDIS_URL ausente/);
  });

  it("erro no Redis: não limita, loga warn no máximo 1×/min e os slots são no-op", async () => {
    process.env.SSE_MAX_PER_USER = "1";
    h.failNext = "zcard";
    const conns = [];
    for (let i = 0; i < 3; i++) conns.push(await open("u1"));
    expect(conns.every((c) => c.r.ok && !c.onEvict.mock.calls.length)).toBe(true);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][1]).toMatch(/Redis indisponível/);
    await okSlot(conns[0].r).heartbeat();
    await okSlot(conns[0].r).release();
    expect(h.warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    await open("u1");
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(await rejected("org_limit")).toBe(0);
    expect(await rejected("user_limit_evicted")).toBe(0);
  });

  it("os dois tetos em 0: nem toca no Redis", async () => {
    process.env.SSE_MAX_PER_USER = "0";
    process.env.SSE_MAX_PER_ORG = "0";
    const c = await open("u1");
    expect(c.r.ok).toBe(true);
    expect(h.zsets.size).toBe(0);
  });
});
