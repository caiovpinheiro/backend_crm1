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
 *
 * Hash (`HSET`/`HGET`/`HDEL`/`HGETALL`) mora no mesmo `store`, com o valor
 * serializado em JSON — o TTL vale para o hash inteiro, como no Redis.
 * Dois processos = dois módulos (`vi.resetModules()`) sobre o mesmo
 * `state`.
 *
 * `EVAL`: scripts com marcador `-- crm:<nome>` na 1ª linha são emulados
 * por nome (ver `FAKE_SCRIPTS`); sem marcador, é o compare-and-delete do
 * lock do cache.
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
      return ops.pexpire(key, Number(seconds) * 1000);
    },
    pexpire(key: string, ms: number): number {
      const hit = state.store.get(key);
      if (!hit || fakeRedisRaw(state, key) === null) return 0;
      hit.expiresAt = Date.now() + Number(ms);
      return 1;
    },
    pttl(key: string): number {
      const hit = state.store.get(key);
      if (!hit || fakeRedisRaw(state, key) === null) return -2;
      if (hit.expiresAt === null) return -1;
      return hit.expiresAt - Date.now();
    },
    hgetall(key: string): Record<string, string> {
      const raw = fakeRedisRaw(state, key);
      return raw === null ? {} : { ...(JSON.parse(raw) as Record<string, string>) };
    },
    hget(key: string, field: string): string | null {
      return ops.hgetall(key)[field] ?? null;
    },
    hset(key: string, field: string, value: string): number {
      const hash = ops.hgetall(key);
      const added = field in hash ? 0 : 1;
      hash[field] = String(value);
      const expiresAt = state.store.get(key)?.expiresAt ?? null;
      state.store.set(key, { value: JSON.stringify(hash), expiresAt });
      return added;
    },
    hdel(key: string, ...fields: string[]): number {
      const hash = ops.hgetall(key);
      let n = 0;
      for (const f of fields) {
        if (f in hash) {
          delete hash[f];
          n++;
        }
      }
      if (Object.keys(hash).length === 0) {
        state.store.delete(key);
      } else if (n > 0) {
        const expiresAt = state.store.get(key)?.expiresAt ?? null;
        state.store.set(key, { value: JSON.stringify(hash), expiresAt });
      }
      return n;
    },
  };

  /** Emulação dos scripts Lua da aplicação, pelo marcador `-- crm:<nome>`. */
  const FAKE_SCRIPTS: Record<string, (keys: string[], args: string[]) => unknown> = {
    // Apaga o campo só se o valor ainda é o lido (presença de viewers).
    "presence-hdel-if-equal": ([key], [field, expected]) =>
      ops.hget(key!, field!) === expected ? ops.hdel(key!, field!) : 0,
    // Claim da janela de coalescência ou, se ocupada, marca de "sujo".
    "coalesce-claim": ([claimKey, dirtyKey], [token, windowMs, dirtyMs]) => {
      if (ops.set(claimKey!, token!, "NX", "PX", Number(windowMs)) === "OK") return -1;
      ops.set(dirtyKey!, "1", "PX", Number(dirtyMs));
      return Math.max(0, ops.pttl(claimKey!));
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
    pexpire(key: string, ms: number) {
      this.queue.push(() => ops.pexpire(key, ms));
      return this;
    }
    hget(key: string, field: string) {
      this.queue.push(() => ops.hget(key, field));
      return this;
    }
    hset(key: string, field: string, value: string) {
      this.queue.push(() => ops.hset(key, field, value));
      return this;
    }
    hdel(key: string, ...fields: string[]) {
      this.queue.push(() => ops.hdel(key, ...fields));
      return this;
    }
    hgetall(key: string) {
      this.queue.push(() => ops.hgetall(key));
      return this;
    }
    del(...keys: string[]) {
      this.queue.push(() => ops.del(...keys));
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
    async hget(key: string, field: string) {
      guard(`HGET ${key}`);
      return ops.hget(key, field);
    }
    async hset(key: string, field: string, value: string) {
      guard(`HSET ${key}`);
      return ops.hset(key, field, value);
    }
    async hdel(key: string, ...fields: string[]) {
      guard(`HDEL ${key}`);
      return ops.hdel(key, ...fields);
    }
    async hgetall(key: string) {
      guard(`HGETALL ${key}`);
      return ops.hgetall(key);
    }
    async pexpire(key: string, ms: number) {
      guard(`PEXPIRE ${key}`);
      return ops.pexpire(key, ms);
    }
    async pttl(key: string) {
      guard(`PTTL ${key}`);
      return ops.pttl(key);
    }
    /**
     * Script com marcador `-- crm:<nome>` → `FAKE_SCRIPTS`; sem marcador, o
     * de liberar lock (compare-and-delete).
     */
    async eval(script: string, n: number, ...rest: string[]) {
      const keys = rest.slice(0, n);
      const args = rest.slice(n);
      guard(`EVAL ${keys.join(" ")}`);
      const marker = /--\s*crm:([\w-]+)/.exec(script)?.[1];
      if (marker) {
        const run = FAKE_SCRIPTS[marker];
        if (!run) throw new Error(`[fake-redis] script sem emulação: ${marker}`);
        return run(keys, args);
      }
      const [key] = keys;
      const [token] = args;
      if (key !== undefined && ops.get(key) === token) {
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
