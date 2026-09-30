/**
 * Setup global do vitest (CL-15): mocka `@/lib/prisma-base` por padrão.
 *
 * Sem isto, qualquer teste que importe um serviço sem mockar o Prisma
 * instancia o client real. Em máquina sem engine compatível (Windows ARM64)
 * o próprio construtor do `PrismaClient` já tenta carregar o engine e vira
 * "Unhandled Rejection" (`PrismaClientInitializationError`) — dezenas por
 * execução, e `vitest run` sai com código 1 mesmo com todos os testes
 * verdes. No CI (Linux) o engine carrega, mas a primeira query de um
 * `void prisma.x()` fire-and-forget morre sem Postgres do mesmo jeito.
 *
 * Semântica do mock: **banco vazio e sem erros**. Leituras devolvem
 * `null`/`[]`/`0`, escritas devolvem `{}`/`{ count: 0 }`, `$transaction`
 * executa o callback com o próprio client, `$extends` devolve o próprio
 * client (o `prisma` scoped de `@/lib/prisma` passa a ser este objeto).
 * `*OrThrow` rejeita com `P2025`, como o Prisma faria.
 *
 * Precedência: um `vi.mock("@/lib/prisma-base", …)` ou
 * `vi.mock("@/lib/prisma", …)` no próprio arquivo de teste vence este —
 * testes que precisam de dados continuam declarando o seu mock.
 *
 * Testes de integração (`*.integration.test.ts`) recebem o módulo REAL:
 * isolamento de tenant não pode ser "validado" contra um banco vazio.
 *
 * O módulo original NÃO é avaliado (`importOriginal`) de propósito — só
 * construir o client já dispara o engine. Os dois helpers puros
 * (`isPgPoolTimeoutError`, `withPgPoolRetry`) não têm importador fora do
 * próprio `prisma-base.ts`; aqui viram stubs de passagem.
 */
import { expect, vi } from "vitest";

type QueryFn = (args?: unknown) => Promise<unknown>;

const LIST_OPS = new Set(["findMany", "groupBy", "findRaw", "aggregateRaw"]);
const COUNT_OPS = new Set(["count"]);
const BATCH_OPS = new Set(["createMany", "updateMany", "deleteMany"]);
const NULL_OPS = new Set(["findUnique", "findFirst"]);
const THROW_OPS = new Set(["findUniqueOrThrow", "findFirstOrThrow"]);

function notFound(model: string, operation: string): Error {
  return Object.assign(
    new Error(`[test-setup] prismaBase mock: ${model}.${operation} sem registro (banco vazio)`),
    { code: "P2025" },
  );
}

function emptyResult(model: string, operation: string): Promise<unknown> {
  if (THROW_OPS.has(operation)) return Promise.reject(notFound(model, operation));
  if (LIST_OPS.has(operation)) return Promise.resolve([]);
  if (COUNT_OPS.has(operation)) return Promise.resolve(0);
  if (BATCH_OPS.has(operation)) return Promise.resolve({ count: 0 });
  if (NULL_OPS.has(operation)) return Promise.resolve(null);
  if (operation === "aggregate") return Promise.resolve({});
  // create / update / upsert / delete / …: objeto vazio
  return Promise.resolve({});
}

function modelDelegate(model: string): Record<string, QueryFn> {
  const cache = new Map<string, QueryFn>();
  return new Proxy({} as Record<string, QueryFn>, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = () => emptyResult(model, prop);
        cache.set(prop, fn);
      }
      return fn;
    },
  });
}

export function createEmptyPrismaClient(): Record<string, unknown> {
  const models = new Map<string, Record<string, QueryFn>>();
  const base: Record<string, unknown> = {};
  const client: Record<string, unknown> = new Proxy(base, {
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
  Object.assign(base, {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $on: () => undefined,
    $use: () => undefined,
    $extends: () => client,
    $transaction: async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client),
    $queryRaw: async () => [],
    $queryRawUnsafe: async () => [],
    $queryRawTyped: async () => [],
    $executeRaw: async () => 0,
    $executeRawUnsafe: async () => 0,
  });
  return client;
}

/** Caminho do arquivo de teste em execução (a factory roda no import dele). */
function currentTestPath(): string {
  try {
    const fromState = expect.getState().testPath;
    if (typeof fromState === "string") return fromState;
  } catch {
    /* fora de um teste */
  }
  const worker = (globalThis as { __vitest_worker__?: { filepath?: unknown } }).__vitest_worker__;
  return typeof worker?.filepath === "string" ? worker.filepath : "";
}

export function isIntegrationTestPath(path: string): boolean {
  return /\.integration\.test\.[cm]?[jt]sx?$/.test(path.replace(/\\/g, "/"));
}

vi.mock("@/lib/prisma-base", async (importOriginal) => {
  if (isIntegrationTestPath(currentTestPath())) {
    return importOriginal<typeof import("@/lib/prisma-base")>();
  }
  const mocked: typeof import("@/lib/prisma-base") = {
    prismaBase: createEmptyPrismaClient() as unknown as typeof import("@/lib/prisma-base").prismaBase,
    isPgPoolTimeoutError: () => false,
    withPgPoolRetry: (fn) => fn(),
  };
  return mocked;
});
