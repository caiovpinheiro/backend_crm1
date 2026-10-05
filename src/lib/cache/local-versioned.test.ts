/**
 * `localVersioned` — cache em memória do processo com invalidação por
 * versão (Redis falso, timers falsos).
 *
 * - N leituras = 1 carga; vence pelo TTL (com teto de 60 s).
 * - `invalidateLocalVersioned` vale na hora no processo que editou e em
 *   até `CACHE_VERSION_MEMO_MS` no "outro processo" (outro módulo sobre o
 *   mesmo Redis).
 * - Um escopo (org) não enxerga nem invalida o outro.
 * - Cargas simultâneas compartilham a mesma promise; rejeição não fica.
 * - Carga que cruza com uma edição não é guardada.
 * - Redis fora: segue funcionando por TTL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  delete process.env.CACHE_VERSION_MEMO_MS;
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

type Mod = typeof import("@/lib/cache/local-versioned");

async function freshProcess(): Promise<Mod> {
  vi.resetModules();
  return import("@/lib/cache/local-versioned");
}

const OPTS = { family: "t_small", scope: ["org_1"], ttlMs: 30_000 };

let mod: Mod;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  mod = await freshProcess();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("localVersioned", () => {
  it("N leituras = 1 carga; recarrega quando o TTL vence", async () => {
    const load = vi.fn(async () => ["a"]);
    for (let i = 0; i < 50; i++) await mod.localVersioned(OPTS, load);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_000);
    await mod.localVersioned(OPTS, load);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await mod.localVersioned(OPTS, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("TTL pedido acima do teto vale 60 s", async () => {
    const load = vi.fn(async () => 1);
    const opts = { ...OPTS, ttlMs: 10 * 60_000 };
    await mod.localVersioned(opts, load);
    await vi.advanceTimersByTimeAsync(mod.MAX_TTL_MS + 1);
    await mod.localVersioned(opts, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a versão é lida no Redis no máximo uma vez por janela de 500 ms", async () => {
    const load = vi.fn(async () => 1);
    for (let i = 0; i < 20; i++) await mod.localVersioned(OPTS, load);
    const reads = h.redis.calls.filter((c) => c.startsWith("GET cache:v:t_small:org_1"));
    expect(reads.length).toBe(1);
  });

  it("invalidar vale na hora no processo que editou", async () => {
    let value = "antes";
    const load = vi.fn(async () => value);
    expect(await mod.localVersioned(OPTS, load)).toBe("antes");
    value = "depois";
    await mod.invalidateLocalVersioned("t_small", "org_1");
    expect(await mod.localVersioned(OPTS, load)).toBe("depois");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("outra réplica enxerga a edição em até 500 ms", async () => {
    let value = "antes";
    const load = vi.fn(async () => value);
    const replicaA = mod;
    expect(await replicaA.localVersioned(OPTS, load)).toBe("antes");

    const replicaB = await freshProcess();
    value = "depois";
    await replicaB.invalidateLocalVersioned("t_small", "org_1");

    // Dentro da janela da memória da versão, A ainda pode servir o antigo.
    await vi.advanceTimersByTimeAsync(501);
    expect(await replicaA.localVersioned(OPTS, load)).toBe("depois");
  });

  it("uma org não enxerga nem invalida a outra", async () => {
    const loadA = vi.fn(async () => "A");
    const loadB = vi.fn(async () => "B");
    const optsB = { ...OPTS, scope: ["org_2"] };
    expect(await mod.localVersioned(OPTS, loadA)).toBe("A");
    expect(await mod.localVersioned(optsB, loadB)).toBe("B");

    await mod.invalidateLocalVersioned("t_small", "org_2");
    await mod.localVersioned(OPTS, loadA);
    await mod.localVersioned(optsB, loadB);
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(2);
  });

  it("`key` separa valores dentro do mesmo escopo", async () => {
    expect(await mod.localVersioned({ ...OPTS, key: "x" }, async () => "x")).toBe("x");
    expect(await mod.localVersioned({ ...OPTS, key: "y" }, async () => "y")).toBe("y");
    expect(await mod.localVersioned({ ...OPTS, key: "x" }, async () => "outro")).toBe("x");
  });

  it("cargas simultâneas compartilham a mesma consulta", async () => {
    let release: (v: string) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const all = Promise.all([
      mod.localVersioned(OPTS, load),
      mod.localVersioned(OPTS, load),
      mod.localVersioned(OPTS, load),
    ]);
    await vi.advanceTimersByTimeAsync(5);
    release("ok");
    expect(await all).toEqual(["ok", "ok", "ok"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejeição não fica guardada", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("banco fora"))
      .mockResolvedValue("ok");
    await expect(mod.localVersioned(OPTS, load)).rejects.toThrow("banco fora");
    expect(await mod.localVersioned(OPTS, load)).toBe("ok");
  });

  it("carga que cruza com uma edição não é guardada", async () => {
    let release: (v: string) => void = () => {};
    const slow = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const first = mod.localVersioned(OPTS, slow);
    await vi.advanceTimersByTimeAsync(5);
    // A edição termina enquanto a leitura antiga ainda está em voo.
    await mod.invalidateLocalVersioned("t_small", "org_1");
    release("estado antigo");
    expect(await first).toBe("estado antigo");

    const fresh = vi.fn(async () => "estado novo");
    expect(await mod.localVersioned(OPTS, fresh)).toBe("estado novo");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("Redis fora: continua servindo por TTL e invalidando no processo", async () => {
    h.redis.down = true;
    let value = "antes";
    const load = vi.fn(async () => value);
    await mod.localVersioned(OPTS, load);
    await mod.localVersioned(OPTS, load);
    expect(load).toHaveBeenCalledTimes(1);

    value = "depois";
    await mod.invalidateLocalVersioned("t_small", "org_1");
    expect(await mod.localVersioned(OPTS, load)).toBe("depois");
  });
});
