/**
 * Coalescência de purga entre réplicas (E4 / N-BE-4). Cada "processo" é uma
 * instância nova do módulo (`vi.resetModules()`) sobre o mesmo Redis falso.
 * Com 2 réplicas, uma rajada na janela vira no máximo 2 purgas no total
 * (leading + trailing) — antes eram 2 por réplica.
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
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { fakeRedisRaw } from "@/test-setup/fake-cache-redis";

const WINDOW = 15_000;
const NAME = "board:org-a";

type Coalesce = typeof import("@/lib/cache/coalesce");

async function newProcess(): Promise<Coalesce> {
  vi.resetModules();
  return import("@/lib/cache/coalesce");
}

let purges: string[] = [];

function schedule(proc: Coalesce, label: string, name = NAME): void {
  proc.scheduleCoalescedPurge(name, WINDOW, () => {
    purges.push(label);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  purges = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleCoalescedPurge com Redis (2 processos)", () => {
  it("rajada nas duas réplicas: uma purga na hora e uma no fim da janela", async () => {
    const a = await newProcess();
    const b = await newProcess();

    schedule(a, "A");
    await vi.advanceTimersByTimeAsync(0);
    expect(purges).toEqual(["A"]);

    for (let i = 0; i < 5; i++) {
      schedule(b, "B");
      schedule(a, "A");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(purges).toEqual(["A"]);

    await vi.advanceTimersByTimeAsync(WINDOW);
    // Trailing feito pela dona (A), uma vez só.
    expect(purges).toEqual(["A", "A"]);

    // Sem eventos na janela do trailing: nada mais.
    await vi.advanceTimersByTimeAsync(WINDOW * 3);
    expect(purges).toEqual(["A", "A"]);
    expect(fakeRedisRaw(h.redis, "cache:coalesce:" + NAME)).toBeNull();
    expect(fakeRedisRaw(h.redis, "cache:coalesce-dirty:" + NAME)).toBeNull();
  });

  it("evento só na seguidora vira o trailing da dona", async () => {
    const a = await newProcess();
    const b = await newProcess();
    schedule(a, "A");
    await vi.advanceTimersByTimeAsync(5_000);
    schedule(b, "B");
    await vi.advanceTimersByTimeAsync(0);
    expect(purges).toEqual(["A"]);
    expect(fakeRedisRaw(h.redis, "cache:coalesce-dirty:" + NAME)).toBe("1");

    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(purges).toEqual(["A", "A"]);
  });

  it("sem evento na janela: só a purga inicial; a próxima é leading de novo", async () => {
    const a = await newProcess();
    const b = await newProcess();
    schedule(a, "A");
    await vi.advanceTimersByTimeAsync(WINDOW + 1);
    expect(purges).toEqual(["A"]);

    schedule(b, "B");
    await vi.advanceTimersByTimeAsync(0);
    expect(purges).toEqual(["A", "B"]);
  });

  it("janelas de nomes diferentes não se misturam", async () => {
    const a = await newProcess();
    const b = await newProcess();
    schedule(a, "A1", "board:org-a");
    schedule(b, "B2", "board:org-b");
    await vi.advanceTimersByTimeAsync(0);
    expect(purges.sort()).toEqual(["A1", "B2"]);
  });

  it("Redis fora: janela por processo, como antes", async () => {
    const a = await newProcess();
    const b = await newProcess();
    h.redis.down = true;
    schedule(a, "A");
    schedule(b, "B");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(purges.sort()).toEqual(["A", "B"]);
    schedule(a, "A");
    await vi.advanceTimersByTimeAsync(WINDOW);
    // Trailing só onde houve evento depois da purga (A).
    expect(purges.sort()).toEqual(["A", "A", "B"]);
  });

  it("seguidora: evento depois da folga volta ao Redis e não se perde", async () => {
    const a = await newProcess();
    const b = await newProcess();
    schedule(a, "A");
    await vi.advanceTimersByTimeAsync(0);
    schedule(b, "B"); // seguidora até ~14 s
    await vi.advanceTimersByTimeAsync(14_500);
    // Já fora da folga e com o claim de A ainda vivo: marca sujo de novo.
    schedule(b, "B");
    await vi.advanceTimersByTimeAsync(0);
    expect(purges).toEqual(["A"]);
    expect(fakeRedisRaw(h.redis, "cache:coalesce-dirty:" + NAME)).toBe("1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(purges).toEqual(["A", "A"]);
  });
});
