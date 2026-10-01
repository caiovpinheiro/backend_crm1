/**
 * Sonda de I/O para testes de contagem (P-10): cliente Prisma espião e
 * Redis falso que registram CADA ida ao banco / ao Redis com o instante
 * (virtual) em que começou e terminou.
 *
 * Como medir "fases"
 * ──────────────────
 * Cada chamada demora um tempo fixo em relógio falso (`vi.useFakeTimers`):
 * 10 ms no Postgres, 1 ms no Redis. Duas chamadas disparadas no mesmo
 * `Promise.all` se sobrepõem; uma chamada feita depois do `await` de outra
 * começa quando a anterior já terminou. A profundidade de uma chamada é
 * `1 + a maior profundidade entre as que já tinham terminado quando ela
 * começou`; o número de fases é a maior profundidade. Com relógio falso o
 * resultado é determinístico (não depende da carga da máquina).
 *
 * Redis é 10× mais rápido que o Postgres de propósito: uma consulta que só
 * sai depois de um GET no Redis (flag → papéis) ainda conta na mesma fase
 * das consultas que saíram junto com o GET.
 *
 * "Consulta" aqui é uma chamada ao cliente Prisma (o que a auditoria
 * contou). Um `select` com relações aninhadas vira mais de um SELECT
 * dentro do query engine, mas é uma ida só do processo da API.
 *
 * Uso (ver `src/app/api/conversations/query-count.test.ts`):
 *
 *   vi.mock("@/lib/prisma-base", async () => {
 *     const { probe } = await import("@/test-setup/io-probe");
 *     return { prismaBase: probe.prisma, … };
 *   });
 *   vi.mock("ioredis", async () => {
 *     const { probe } = await import("@/test-setup/io-probe");
 *     return { default: probe.FakeRedis };
 *   });
 */
import { vi } from "vitest";

export type IoKind = "pg" | "redis";

export type IoEntry = {
  kind: IoKind;
  /** `conversation.findFirst`, `GET cache:authz:…` */
  label: string;
  start: number;
  end: number;
  args: unknown;
};

export type IoStats = {
  count: number;
  phases: number;
  /** Rótulos por fase, na ordem em que saíram. */
  byPhase: string[][];
};

export type DbHandler = (model: string, operation: string, args: unknown) => unknown;

const PG_LATENCY_MS = 10;
const REDIS_LATENCY_MS = 1;

const LIST_OPS = new Set(["findMany", "groupBy"]);
const BATCH_OPS = new Set(["createMany", "updateMany", "deleteMany"]);
const NULL_OPS = new Set(["findUnique", "findFirst"]);

/** Mesmo "banco vazio" do mock global (`mock-prisma-base.ts`). */
export function emptyDbResult(operation: string): unknown {
  if (LIST_OPS.has(operation)) return [];
  if (operation === "count") return 0;
  if (BATCH_OPS.has(operation)) return { count: 0 };
  if (NULL_OPS.has(operation)) return null;
  return {};
}

function createProbe() {
  let log: IoEntry[] = [];
  let dbHandler: DbHandler | null = null;
  const redisStore = new Map<string, string>();

  function track<T>(
    kind: IoKind,
    label: string,
    args: unknown,
    produce: () => T | Promise<T>,
  ): Promise<T> {
    const entry: IoEntry = { kind, label, start: Date.now(), end: -1, args };
    log.push(entry);
    return new Promise<T>((resolve, reject) => {
      setTimeout(
        () => {
          entry.end = Date.now();
          try {
            Promise.resolve(produce()).then(resolve, reject);
          } catch (err) {
            reject(err);
          }
        },
        kind === "pg" ? PG_LATENCY_MS : REDIS_LATENCY_MS,
      );
    });
  }

  function runDb(model: string, operation: string, args: unknown): unknown {
    const custom = dbHandler?.(model, operation, args);
    return custom === undefined ? emptyDbResult(operation) : custom;
  }

  type QueryFn = (args?: unknown) => Promise<unknown>;

  function modelDelegate(model: string): Record<string, QueryFn> {
    const fns = new Map<string, QueryFn>();
    return new Proxy({} as Record<string, QueryFn>, {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        let fn = fns.get(prop);
        if (!fn) {
          fn = (args?: unknown) =>
            track("pg", `${model}.${prop}`, args, () => runDb(model, prop, args));
          fns.set(prop, fn);
        }
        return fn;
      },
    });
  }

  const models = new Map<string, Record<string, QueryFn>>();
  const base: Record<string, unknown> = {};
  const prisma: Record<string, unknown> = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop in target) return target[prop];
      let delegate = models.get(prop);
      if (!delegate) {
        delegate = modelDelegate(prop);
        models.set(prop, delegate);
      }
      return delegate;
    },
  });
  const raw =
    (name: string, empty: unknown) =>
    (...args: unknown[]) =>
      track("pg", name, args, () => {
        const custom = dbHandler?.(name, "raw", args);
        return custom === undefined ? empty : custom;
      });
  Object.assign(base, {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $on: () => undefined,
    $use: () => undefined,
    $extends: () => prisma,
    $transaction: async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => Promise<unknown>)(prisma),
    $queryRaw: raw("$queryRaw", []),
    $queryRawUnsafe: raw("$queryRawUnsafe", []),
    $executeRaw: raw("$executeRaw", 0),
    $executeRawUnsafe: raw("$executeRawUnsafe", 0),
  });

  /**
   * Imita a extension de tenant de `@/lib/prisma` por cima do cliente
   * espião: nos modelos de `scopedModels`, soma `organizationId` do
   * contexto ao `where`. Super-admin passa direto; sem contexto, lança —
   * como o cliente real. Serve para o `vi.mock("@/lib/prisma")` dos testes
   * que precisam provar isolamento entre organizações.
   */
  function scoped(
    scopedModels: ReadonlySet<string>,
    getContext: () => { organizationId: string | null; isSuperAdmin: boolean } | undefined,
  ): Record<string, unknown> {
    const delegates = new Map<string, Record<string, QueryFn>>();
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop.startsWith("$") || !scopedModels.has(prop)) return prisma[prop];
        let delegate = delegates.get(prop);
        if (!delegate) {
          const inner = prisma[prop] as Record<string, QueryFn>;
          delegate = new Proxy({} as Record<string, QueryFn>, {
            get(_t, op) {
              if (typeof op !== "string" || op === "then") return undefined;
              return (args?: unknown) => {
                const ctx = getContext();
                if (!ctx) {
                  throw new Error(`[io-probe] prisma.${prop}.${op} fora de RequestContext`);
                }
                if (ctx.isSuperAdmin) return inner[op]!(args);
                const a = (args ?? {}) as Record<string, unknown>;
                return inner[op]!({
                  ...a,
                  where: {
                    AND: [a.where ?? {}, { organizationId: ctx.organizationId ?? "__none__" }],
                  },
                });
              };
            },
          });
          delegates.set(prop, delegate);
        }
        return delegate;
      },
    });
  }

  /** Subconjunto do ioredis que `@/lib/cache` usa. */
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
    get(key: string) {
      return track("redis", `GET ${key}`, [key], () => redisStore.get(key) ?? null);
    }
    set(key: string, value: string, ...args: unknown[]) {
      return track("redis", `SET ${key}`, [key], () => {
        if (args.includes("NX") && redisStore.has(key)) return null;
        redisStore.set(key, value);
        return "OK";
      });
    }
    del(...keys: string[]) {
      return track("redis", `DEL ${keys.join(" ")}`, keys, () => {
        let n = 0;
        for (const k of keys) if (redisStore.delete(k)) n++;
        return n;
      });
    }
    unlink(...keys: string[]) {
      return this.del(...keys);
    }
    scan() {
      return track("redis", "SCAN", [], () => ["0", [] as string[]]);
    }
    eval(_script: string, _n: number, key: string, token: string) {
      return track("redis", `EVAL ${key}`, [key], () => {
        if (redisStore.get(key) === token) {
          redisStore.delete(key);
          return 1;
        }
        return 0;
      });
    }
  }

  function stats(kind: IoKind, entries: IoEntry[] = log): IoStats {
    const own = entries.filter((e) => e.kind === kind);
    const depth: number[] = [];
    own.forEach((e, i) => {
      let d = 1;
      own.forEach((p, j) => {
        if (j !== i && p.end >= 0 && p.end <= e.start && depth[j] !== undefined) {
          d = Math.max(d, depth[j]! + 1);
        }
      });
      depth[i] = d;
    });
    const phases = depth.length > 0 ? Math.max(...depth) : 0;
    const byPhase: string[][] = Array.from({ length: phases }, () => []);
    own.forEach((e, i) => byPhase[depth[i]! - 1]!.push(e.label));
    return { count: own.length, phases, byPhase };
  }

  /**
   * Executa `fn` avançando o relógio falso até a promise assentar.
   * Devolve o resultado e o que foi registrado só nesta execução.
   */
  async function run<T>(
    fn: () => Promise<T> | T,
  ): Promise<{ result: T; entries: IoEntry[] }> {
    const from = log.length;
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    void Promise.resolve()
      .then(fn)
      .then(
        (v) => {
          value = v;
          settled = true;
        },
        (e) => {
          error = e;
          failed = true;
          settled = true;
        },
      );
    for (let i = 0; i < 5_000 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    if (!settled) {
      throw new Error("[io-probe] a execução não terminou em 5 s virtuais");
    }
    // Fire-and-forget disparado no fim do handler ainda entra na conta.
    await vi.advanceTimersByTimeAsync(PG_LATENCY_MS * 3);
    if (failed) throw error;
    return { result: value as T, entries: log.slice(from) };
  }

  return {
    prisma,
    scoped,
    FakeRedis,
    redisStore,
    run,
    stats,
    get log() {
      return log;
    },
    setDbHandler(handler: DbHandler | null) {
      dbHandler = handler;
    },
    reset() {
      log = [];
      redisStore.clear();
      dbHandler = null;
    },
  };
}

export const probe = createProbe();

/** Texto curto para o corpo do PR / saída do teste. */
export function describeStats(name: string, pg: IoStats, redis: IoStats): string {
  const lines = [
    `${name}: ${pg.count} consultas em ${pg.phases} fase(s); ${redis.count} ida(s) ao Redis, ${redis.phases} em série`,
  ];
  pg.byPhase.forEach((labels, i) => {
    lines.push(`  PG fase ${i + 1} (${labels.length}): ${labels.join(", ")}`);
  });
  redis.byPhase.forEach((labels, i) => {
    lines.push(`  Redis série ${i + 1} (${labels.length}): ${labels.join(", ")}`);
  });
  return lines.join("\n");
}
