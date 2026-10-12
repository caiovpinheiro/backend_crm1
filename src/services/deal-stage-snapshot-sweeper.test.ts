/**
 * Snapshot diário do estoque por etapa agendado no worker
 * (`deal-stage-snapshot-sweeper.ts`).
 *
 * Em produção a rota `/api/cron/deal-stage-snapshot` nunca era chamada (o
 * Scheduled Service externo não existe) e a "Evolução diária" ficava sem
 * histórico. O tick:
 * - grava a partir das 03:05 de São Paulo, uma vez por dia civil de SP;
 * - com 2 réplicas, só uma grava (trava no Redis);
 * - é idempotente (upsert por org + etapa + dia);
 * - `DEAL_STAGE_SNAPSHOT_WORKER=0` desliga;
 * - falha solta a trava para o próximo tick tentar de novo.
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
    orgs: [{ id: "org_a" }, { id: "org_b" }],
    queryRaw: vi.fn(),
    executeRaw: vi.fn(),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    organization: { findMany: async () => h.orgs },
    $queryRaw: h.queryRaw,
    $executeRaw: h.executeRaw,
  },
}));

type SweeperModule = typeof import("@/services/deal-stage-snapshot-sweeper");

/** Hora civil de São Paulo (UTC-3) → instante. */
const sp = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm));

/** SQL do upsert (Prisma.sql de tag: os pedaços vêm no 1º argumento). */
function upsertSqls(): string[] {
  return h.executeRaw.mock.calls
    .map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join("?") : String(c[0])))
    .map((s) => s.replace(/\s+/g, " "))
    .filter((s) => s.includes("INSERT INTO deal_stage_daily_snapshots"));
}

async function loadSweeper(): Promise<SweeperModule> {
  return import("@/services/deal-stage-snapshot-sweeper");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(sp(12, 3, 10));
  delete process.env.DEAL_STAGE_SNAPSHOT_WORKER;
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.queryRaw.mockReset();
  h.executeRaw.mockReset();
  h.queryRaw.mockImplementation(async () => [
    { pipelineId: "p1", stageId: "s1", cnt: 4n, val: 100 },
    { pipelineId: "p1", stageId: "s2", cnt: 2n, val: 0 },
  ]);
  h.executeRaw.mockImplementation(async () => 0);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.DEAL_STAGE_SNAPSHOT_WORKER;
});

describe("runDealStageSnapshotTick", () => {
  it("antes das 03:05 de SP não grava; a partir delas grava o dia civil de SP", async () => {
    const s = await loadSweeper();
    expect(await s.runDealStageSnapshotTick(sp(12, 3, 4))).toEqual({ ran: false, reason: "not-yet" });
    expect(h.executeRaw).not.toHaveBeenCalled();

    const out = await s.runDealStageSnapshotTick(sp(12, 3, 5));
    expect(out).toEqual({ ran: true, orgs: 2, rows: 4, pruned: 0, date: "2026-10-12" });
    expect(upsertSqls()).toHaveLength(2);
  });

  it("idempotente: a gravação é upsert por (org, etapa, dia)", async () => {
    const s = await loadSweeper();
    await s.runDealStageSnapshotTick(sp(12, 3, 5));
    for (const sql of upsertSqls()) {
      expect(sql).toContain('ON CONFLICT ("organizationId", "stageId", date) DO UPDATE SET');
    }
  });

  it("duas réplicas: só uma grava no dia; no dia seguinte grava de novo", async () => {
    const a = await loadSweeper();
    vi.resetModules();
    const b = await loadSweeper();
    expect(a).not.toBe(b);

    expect((await a.runDealStageSnapshotTick(sp(12, 3, 5))).ran).toBe(true);
    expect(await b.runDealStageSnapshotTick(sp(12, 3, 10))).toEqual({
      ran: false,
      reason: "claimed-elsewhere",
    });
    // Mesma réplica, mais tarde no mesmo dia: também não repete.
    expect(await a.runDealStageSnapshotTick(sp(12, 22))).toEqual({
      ran: false,
      reason: "claimed-elsewhere",
    });
    expect(upsertSqls()).toHaveLength(2);

    vi.setSystemTime(sp(13, 3, 5));
    const next = await b.runDealStageSnapshotTick(sp(13, 3, 5));
    expect(next).toMatchObject({ ran: true, date: "2026-10-13" });
    expect(a.dealStageSnapshotClaimKey(sp(13, 3, 5))).toBe("deal-stage-snapshot:2026-10-13");
  });

  it("worker fora do ar às 03:05: grava no primeiro tick do mesmo dia", async () => {
    const s = await loadSweeper();
    expect(await s.runDealStageSnapshotTick(sp(12, 14, 30))).toMatchObject({
      ran: true,
      date: "2026-10-12",
    });
  });

  it("DEAL_STAGE_SNAPSHOT_WORKER=0 desliga", async () => {
    process.env.DEAL_STAGE_SNAPSHOT_WORKER = "0";
    const s = await loadSweeper();
    expect(await s.runDealStageSnapshotTick(sp(12, 3, 5))).toEqual({ ran: false, reason: "disabled" });
    expect(s.isDealStageSnapshotWorkerEnabled()).toBe(false);
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it("falha solta a trava: o próximo tick tenta de novo", async () => {
    const s = await loadSweeper();
    h.queryRaw.mockRejectedValueOnce(new Error("conexão caiu"));
    await expect(s.runDealStageSnapshotTick(sp(12, 3, 5))).rejects.toThrow("conexão caiu");
    expect((await s.runDealStageSnapshotTick(sp(12, 3, 10))).ran).toBe(true);
  });
});
