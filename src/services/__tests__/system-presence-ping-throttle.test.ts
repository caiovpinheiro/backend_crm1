/**
 * Ping de presença: no máximo 1 gravação por usuário a cada 45 s.
 *
 * O `cache` é o módulo REAL; só o cliente Redis é falso (um Map com
 * `SET … EX … NX` e `DEL`), então o teste passa pelo mesmo `tryClaim` da
 * produção. Banco falso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const fakeRedis = {
    calls: [] as unknown[][],
    set: async (key: string, value: string, ex: string, ttlSec: number, nx: string) => {
      fakeRedis.calls.push(["set", key, value, ex, ttlSec, nx]);
      const hit = store.get(key);
      if (hit && hit.expiresAt > Date.now()) return null;
      store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
      return "OK";
    },
    del: async (...keys: string[]) => {
      fakeRedis.calls.push(["del", ...keys]);
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
  };
  return {
    store,
    fakeRedis,
    /** `null` simula processo sem REDIS_URL. */
    client: fakeRedis as typeof fakeRedis | null,
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    queryRaw: vi.fn(),
  };
});

vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => h.client,
  circuitIsOpen: () => false,
  noteSuccess: () => {},
  noteFailure: () => {},
  waitUntilCacheReady: async () => true,
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    systemUsageSession: { updateMany: h.updateMany, findFirst: h.findFirst },
    $queryRaw: h.queryRaw,
  },
}));
vi.mock("@/lib/realtime-events", () => ({
  publishSystemPresenceUpdate: vi.fn(),
}));

import { cache } from "@/lib/cache";
import { POST } from "@/app/api/agents/me/ping/route";
import {
  SYSTEM_PRESENCE_PING_WRITE_INTERVAL_SEC,
  SYSTEM_PRESENCE_STALE_MS,
  presencePingClaimKey,
  recordHeartbeatThrottled,
} from "@/services/system-presence";

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (fn: (session: unknown) => unknown) =>
    fn({ user: { id: "user-1", organizationId: "org-1" } }),
}));

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const ping = (userId = "user-1") =>
  recordHeartbeatThrottled({ userId, organizationId: "org-1" });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.store.clear();
  h.fakeRedis.calls = [];
  h.client = h.fakeRedis;
  // Limpa o fallback em memória do módulo de cache entre os testes.
  await cache.del(presencePingClaimKey("user-1"), presencePingClaimKey("user-2"));
  h.fakeRedis.calls = [];
  h.updateMany.mockReset().mockResolvedValue({ count: 1 });
  h.findFirst.mockReset().mockResolvedValue({ id: "sess-1" });
  h.queryRaw.mockReset().mockResolvedValue([{ id: "sess-new", created: true }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recordHeartbeatThrottled", () => {
  it("o intervalo é 45 s e cabe com folga no limite de inatividade (300 s ≥ 90 s)", () => {
    expect(SYSTEM_PRESENCE_STALE_MS).toBeGreaterThanOrEqual(90_000);
    expect(SYSTEM_PRESENCE_PING_WRITE_INTERVAL_SEC).toBe(45);
    expect(SYSTEM_PRESENCE_PING_WRITE_INTERVAL_SEC * 1000 * 2).toBeLessThanOrEqual(
      SYSTEM_PRESENCE_STALE_MS,
    );
  });

  it("primeiro ping grava e faz SET presence:ping:<userId> 1 EX 45 NX", async () => {
    expect(await ping()).toEqual({ created: false, written: true });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.fakeRedis.calls).toEqual([
      ["set", "cache:presence:ping:user-1", "1", "EX", 45, "NX"],
    ]);
  });

  it("pings dentro de 45 s não tocam no banco; depois de 45 s grava de novo", async () => {
    await ping();
    for (const dt of [1_000, 20_000, 44_000]) {
      vi.setSystemTime(T0 + dt);
      expect(await ping()).toEqual({ created: false, written: false });
    }
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.findFirst).toHaveBeenCalledTimes(1);
    expect(h.queryRaw).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + 45_001);
    expect(await ping()).toEqual({ created: false, written: true });
    expect(h.updateMany).toHaveBeenCalledTimes(2);
  });

  it("um minuto de pings a cada 5 s (várias abas) vira 2 gravações, não 12", async () => {
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(T0 + i * 5_000);
      await ping();
    }
    expect(h.updateMany).toHaveBeenCalledTimes(2);
  });

  it("o limite é por usuário", async () => {
    await ping("user-1");
    expect(await ping("user-2")).toEqual({ created: false, written: true });
    expect(h.updateMany).toHaveBeenCalledTimes(2);
  });

  it("sessão nova (sem sessão aberta) continua sendo criada e sinalizada", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    expect(await ping()).toEqual({ created: true, written: true });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("falha na gravação solta o claim: o próximo ping tenta de novo", async () => {
    h.updateMany.mockRejectedValueOnce(new Error("pool timeout"));
    await expect(ping()).rejects.toThrow("pool timeout");
    expect(h.fakeRedis.calls.at(-1)).toEqual(["del", "cache:presence:ping:user-1"]);

    vi.setSystemTime(T0 + 2_000);
    expect(await ping()).toEqual({ created: false, written: true });
    expect(h.updateMany).toHaveBeenCalledTimes(2);
  });

  it("sem Redis: fallback em memória — grava, segura a janela e volta a gravar", async () => {
    h.client = null;
    expect(await ping()).toEqual({ created: false, written: true });
    vi.setSystemTime(T0 + 10_000);
    expect(await ping()).toEqual({ created: false, written: false });
    vi.setSystemTime(T0 + 46_000);
    expect(await ping()).toEqual({ created: false, written: true });
    expect(h.updateMany).toHaveBeenCalledTimes(2);
    expect(h.fakeRedis.calls).toEqual([]);
  });

  it("Redis com erro: não perde heartbeat (cai no fallback e grava)", async () => {
    const original = h.fakeRedis.set;
    h.fakeRedis.set = async () => {
      throw new Error("Command timed out");
    };
    try {
      expect(await ping()).toEqual({ created: false, written: true });
      expect(h.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      h.fakeRedis.set = original;
    }
  });
});

describe("POST /api/agents/me/ping", () => {
  it("responde 200 com o mesmo formato, gravando só no primeiro ping da janela", async () => {
    const first = await POST();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, systemOnline: true, created: false });

    vi.setSystemTime(T0 + 5_000);
    const second = await POST();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, systemOnline: true, created: false });

    expect(h.updateMany).toHaveBeenCalledTimes(1);
  });
});
