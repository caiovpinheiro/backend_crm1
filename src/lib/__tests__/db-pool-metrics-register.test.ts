/**
 * `createPrismaClient` registra o pool pg em `db-pool-metrics`: sem isto o
 * gauge `crm_db_pool_connections` ficava zerado para sempre. pg, adapter e
 * PrismaClient falsos — nada conecta.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pools: [] as Array<Record<string, unknown>>,
}));

// O setup global (`src/test-setup/mock-prisma-base.ts`) troca
// `@/lib/prisma-base` por um client vazio. Aqui o módulo REAL tem que
// rodar — é o `createPrismaClient` dele que registra o pool no gauge —,
// com pg/adapter/PrismaClient falsos (abaixo). Nada conecta.
vi.unmock("@/lib/prisma-base");

vi.mock("pg", () => ({
  Pool: class FakePool {
    totalCount = 5;
    idleCount = 2;
    waitingCount = 1;
    constructor(public options: unknown) {
      h.pools.push(this as unknown as Record<string, unknown>);
    }
    on() {
      return this;
    }
  },
}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class FakeAdapter {
    constructor(public pool: unknown) {}
  },
}));
vi.mock("@prisma/client", () => ({
  PrismaClient: class FakePrismaClient {
    constructor(public options: unknown) {}
  },
}));

const savedArch = Object.getOwnPropertyDescriptor(process, "arch");
const savedEngine = process.env.PRISMA_CLIENT_ENGINE_TYPE;

beforeAll(() => {
  // Windows ARM64 usa o engine binário sem adapter (e sem pool): força o
  // caminho com pool para o teste valer em qualquer máquina.
  Object.defineProperty(process, "arch", { value: "x64", configurable: true });
  delete process.env.PRISMA_CLIENT_ENGINE_TYPE;
  process.env.DATABASE_URL = "postgresql://ci:ci@localhost:5432/ci";
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterAll(() => {
  if (savedArch) Object.defineProperty(process, "arch", savedArch);
  if (savedEngine !== undefined) process.env.PRISMA_CLIENT_ENGINE_TYPE = savedEngine;
  vi.restoreAllMocks();
});

describe("prisma-base: pool registrado para o gauge", () => {
  it("collectDbPool lê total/idle/active/waiting do pool criado", async () => {
    await import("@/lib/prisma-base");
    expect(h.pools).toHaveLength(1);

    const { collectDbPool } = await import("@/lib/db-pool-metrics");
    const { metrics } = await import("@/lib/metrics");
    await collectDbPool();

    const snap = await metrics.db.pool.get();
    const byState = Object.fromEntries(
      snap.values.map((v) => [v.labels.state, v.value]),
    );
    expect(byState).toEqual({ total: 5, idle: 2, active: 3, waiting: 1 });
  }, 30_000);
});
