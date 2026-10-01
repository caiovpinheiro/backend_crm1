/**
 * Redis falso em memória para os testes do cache (sem rede).
 *
 * Uso:
 *
 *   const h = vi.hoisted(() => {
 *     process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
 *     return { redis: { store: new Map(), calls: [], down: false } };
 *   });
 *   vi.mock("ioredis", async () =>
 *     (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
 *   );
 *
 * - `store`: o que está no "Redis" (TTL respeita `Date.now()`, então
 *   funciona com timers falsos).
 * - `calls`: um registro por comando (`"GET cache:x"`, `"SCAN ..."`), para
 *   afirmar quantas idas ao Redis houve e que SCAN não foi chamado.
 * - `down = true`: todo comando rejeita, como conexão caída.
 */
export type FakeRedisState = {
  store: Map<string, { value: string; expiresAt: number | null }>;
  calls: string[];
  down: boolean;
};

export function newFakeRedisState(): FakeRedisState {
  return { store: new Map(), calls: [], down: false };
}

/** Comandos registrados cujo nome é `command` (ex.: `"SCAN"`). */
export function fakeRedisCalls(state: FakeRedisState, command: string): string[] {
  return state.calls.filter((c) => c === command || c.startsWith(`${command} `));
}

/** Valor cru de uma chave, já descontado o TTL. */
export function fakeRedisRaw(state: FakeRedisState, key: string): string | null {
  const hit = state.store.get(key);
  if (!hit) return null;
  if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
    state.store.delete(key);
    return null;
  }
  return hit.value;
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

type Queued = () => unknown;

export function fakeIoredisModule(state: FakeRedisState) {
  function guard(call: string): void {
    state.calls.push(call);
    if (state.down) throw new Error("Connection is closed.");
  }

  function ttlFrom(args: unknown[]): number | null {
    const ex = args.indexOf("EX");
    if (ex >= 0) return Date.now() + Number(args[ex + 1]) * 1000;
    const px = args.indexOf("PX");
    if (px >= 0) return Date.now() + Number(args[px + 1]);
    return null;
  }

  const ops = {
    get(key: string): string | null {
      return fakeRedisRaw(state, key);
    },
    set(key: string, value: string, ...args: unknown[]): "OK" | null {
      if (args.includes("NX") && fakeRedisRaw(state, key) !== null) return null;
      state.store.set(key, { value: String(value), expiresAt: ttlFrom(args) });
      return "OK";
    },
    del(...keys: string[]): number {
      let n = 0;
      for (const k of keys) {
        if (fakeRedisRaw(state, k) !== null) n++;
        state.store.delete(k);
      }
      return n;
    },
    incrby(key: string, by: number): number {
      const current = fakeRedisRaw(state, key);
      const next = Number(current ?? 0) + Number(by);
      const expiresAt = state.store.get(key)?.expiresAt ?? null;
      state.store.set(key, { value: String(next), expiresAt });
      return next;
    },
    expire(key: string, seconds: number): number {
      const hit = state.store.get(key);
      if (!hit || fakeRedisRaw(state, key) === null) return 0;
      hit.expiresAt = Date.now() + Number(seconds) * 1000;
      return 1;
    },
  };

  class FakeMulti {
    private queue: Queued[] = [];
    set(key: string, value: string, ...args: unknown[]) {
      this.queue.push(() => ops.set(key, value, ...args));
      return this;
    }
    incrby(key: string, by: number) {
      this.queue.push(() => ops.incrby(key, by));
      return this;
    }
    expire(key: string, seconds: number) {
      this.queue.push(() => ops.expire(key, seconds));
      return this;
    }
    async exec(): Promise<Array<[Error | null, unknown]>> {
      guard(`MULTI ${this.queue.length}`);
      return this.queue.map((run) => [null, run()]);
    }
  }

  class FakeRedis {
    status = "ready";
    on() {
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    disconnect() {}
    async get(key: string) {
      guard(`GET ${key}`);
      return ops.get(key);
    }
    async set(key: string, value: string, ...args: unknown[]) {
      guard(`SET ${key}`);
      return ops.set(key, value, ...args);
    }
    async del(...keys: string[]) {
      guard(`DEL ${keys.join(" ")}`);
      return ops.del(...keys);
    }
    async unlink(...keys: string[]) {
      guard(`UNLINK ${keys.join(" ")}`);
      return ops.del(...keys);
    }
    async scan(_cursor: string, _match: string, pattern: string) {
      guard(`SCAN ${pattern}`);
      const re = globToRegExp(pattern);
      const keys = [...state.store.keys()].filter(
        (k) => fakeRedisRaw(state, k) !== null && re.test(k),
      );
      return ["0", keys];
    }
    /** Só o script de liberar lock (compare-and-delete). */
    async eval(_script: string, _n: number, key: string, token: string) {
      guard(`EVAL ${key}`);
      if (ops.get(key) === token) {
        state.store.delete(key);
        return 1;
      }
      return 0;
    }
    multi() {
      return new FakeMulti();
    }
  }

  return { default: FakeRedis };
}
