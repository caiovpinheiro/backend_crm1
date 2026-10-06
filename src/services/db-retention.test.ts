/**
 * C4 da auditoria de banco (05/10) — retenção de `meta_webhook_events`.
 *
 * Serviço (`db-retention.ts`):
 * - só apaga evento JÁ processado e mais velho que a janela (30 dias por
 *   padrão, `DB_RETENTION_META_WEBHOOK_DAYS`);
 * - em lotes de 5 mil, com teto por rodada;
 * - recusa a rodada se faltar um dos índices de que o DELETE depende.
 *
 * Job do worker (`db-retention-sweeper.ts`):
 * - só roda na janela da madrugada, uma instância por dia (trava no Redis);
 * - só `meta_webhook_events` por padrão, sem o count prévio;
 * - loga o total apagado.
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
    queryRaw: vi.fn(),
    executeRaw: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: h.warn, info: h.info, debug: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { $queryRawUnsafe: h.queryRaw, $executeRawUnsafe: h.executeRaw },
}));

import { runDbRetention } from "@/services/db-retention";
import {
  isInsideRetentionWindow,
  retentionClaimKey,
  runDbRetentionTick,
} from "@/services/db-retention-sweeper";

const ENV_KEYS = [
  "DB_RETENTION_META_WEBHOOK_DAYS",
  "DB_RETENTION_WORKER",
  "DB_RETENTION_WORKER_HOUR_UTC",
  "DB_RETENTION_WORKER_TARGETS",
  "DB_RETENTION_WORKER_MAX_BATCHES",
  "DB_RETENTION_WORKER_PAUSE_MS",
];

/** 05/10/2026 06:30 UTC = 03:30 em Brasília, dentro da janela padrão. */
const NIGHT = new Date("2026-10-05T06:30:00.000Z");
const DAY_MS = 86_400_000;

let indexesPresent = true;
let countResult = 12_000;
/** Linhas devolvidas por cada lote de DELETE, na ordem. */
let batchSizes: number[] = [];

function sqlCalls(mock: typeof h.queryRaw): string[] {
  return mock.mock.calls.map((c) => String(c[0]).replace(/\s+/g, " ").trim());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NIGHT);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DB_RETENTION_WORKER_PAUSE_MS = "0";
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.queryRaw.mockReset();
  h.executeRaw.mockReset();
  h.info.mockReset();
  h.warn.mockReset();
  indexesPresent = true;
  countResult = 12_000;
  batchSizes = [5_000, 5_000, 1_200];
  h.queryRaw.mockImplementation(async (sql: string) => {
    if (sql.includes("pg_index")) return [{ ok: indexesPresent }];
    return [{ count: BigInt(countResult) }];
  });
  h.executeRaw.mockImplementation(async () => batchSizes.shift() ?? 0);
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("runDbRetention — meta_webhook_events", () => {
  it("apaga em lotes só o que já foi processado e passou de 30 dias", async () => {
    const run = await runDbRetention({ apply: true, only: ["meta_webhook_events"] });

    expect(run.targets).toEqual([
      {
        key: "meta_webhook_events",
        cutoff: new Date(NIGHT.getTime() - 30 * DAY_MS).toISOString(),
        candidates: 12_000,
        deleted: 11_200,
        batches: 3,
        hitCap: false,
      },
    ]);

    const deletes = sqlCalls(h.executeRaw);
    expect(deletes).toHaveLength(3);
    for (const sql of deletes) {
      expect(sql).toContain('DELETE FROM "meta_webhook_events"');
      expect(sql).toContain('"receivedAt" < $1 AND "processed" = true');
      expect(sql).toContain("LIMIT 5000");
    }
    // O corte vai como parâmetro, em todas as chamadas.
    for (const call of h.executeRaw.mock.calls) {
      expect((call[1] as Date).toISOString()).toBe(run.targets[0]!.cutoff);
    }
    // A contagem do dry-run usa o mesmo filtro.
    expect(sqlCalls(h.queryRaw)[0]).toContain('"receivedAt" < $1 AND "processed" = true');
  });

  it("dry-run conta e não apaga", async () => {
    const run = await runDbRetention({ apply: false, only: ["meta_webhook_events"] });
    expect(run.targets[0]).toMatchObject({ candidates: 12_000, deleted: 0, batches: 0 });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it("a janela vem do env", async () => {
    process.env.DB_RETENTION_META_WEBHOOK_DAYS = "14";
    const run = await runDbRetention({ apply: false, only: ["meta_webhook_events"] });
    expect(run.targets[0]!.cutoff).toBe(new Date(NIGHT.getTime() - 14 * DAY_MS).toISOString());
  });

  it("sem o índice de receivedAt ou o da FK de automation_logs não apaga nada", async () => {
    indexesPresent = false;
    const run = await runDbRetention({ apply: true, only: ["meta_webhook_events"] });
    expect(h.executeRaw).not.toHaveBeenCalled();
    expect(run.targets[0]).toMatchObject({ deleted: 0, batches: 0 });
    expect(run.targets[0]!.skipped).toContain('meta_webhook_events("receivedAt")');
    expect(run.targets[0]!.skipped).toContain('automation_logs("metaWebhookEventId")');
  });

  it("respeita o teto de lotes da rodada", async () => {
    batchSizes = [5_000, 5_000, 5_000, 5_000];
    const run = await runDbRetention({
      apply: true,
      only: ["meta_webhook_events"],
      maxBatches: 2,
    });
    expect(run.targets[0]).toMatchObject({ deleted: 10_000, batches: 2, hitCap: true });
    expect(h.executeRaw).toHaveBeenCalledTimes(2);
  });

  it("count: false pula a contagem e ainda apaga", async () => {
    const run = await runDbRetention({
      apply: true,
      only: ["meta_webhook_events"],
      count: false,
    });
    expect(run.targets[0]).toMatchObject({ candidates: null, deleted: 11_200 });
    expect(sqlCalls(h.queryRaw).every((sql) => sql.includes("pg_index"))).toBe(true);
  });

  it("as outras tabelas seguem sem filtro extra nem exigência de índice", async () => {
    batchSizes = [10];
    await runDbRetention({ apply: true, only: ["distribution_logs"] });
    expect(sqlCalls(h.executeRaw)[0]).toContain('WHERE "createdAt" < $1 LIMIT 5000');
    expect(sqlCalls(h.queryRaw).some((sql) => sql.includes("pg_index"))).toBe(false);
  });
});

describe("job diário do worker", () => {
  it("fora da janela da madrugada não faz nada", async () => {
    const noon = new Date("2026-10-05T15:00:00.000Z");
    expect(isInsideRetentionWindow(noon)).toBe(false);
    expect(await runDbRetentionTick(noon)).toEqual({ ran: false, reason: "outside-window" });
    expect(h.executeRaw).not.toHaveBeenCalled();
    expect(h.redis.calls).toHaveLength(0);
  });

  it("na janela, roda só meta_webhook_events, sem count, e loga o total", async () => {
    const out = await runDbRetentionTick(NIGHT);
    expect(out.ran).toBe(true);
    if (!out.ran) return;
    expect(out.run.targets.map((t) => t.key)).toEqual(["meta_webhook_events"]);
    expect(out.run.targets[0]).toMatchObject({ candidates: null, deleted: 11_200, batches: 3 });
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({ table: "meta_webhook_events", deleted: 11_200, batches: 3 }),
      expect.stringContaining("11200 linhas apagadas"),
    );
  });

  it("só uma instância por dia: o segundo tick (ou a outra réplica) não roda", async () => {
    expect((await runDbRetentionTick(NIGHT)).ran).toBe(true);
    h.executeRaw.mockClear();

    const later = new Date(NIGHT.getTime() + 20 * 60_000);
    expect(await runDbRetentionTick(later)).toEqual({ ran: false, reason: "claimed-elsewhere" });
    expect(h.executeRaw).not.toHaveBeenCalled();

    // No dia seguinte a trava é outra.
    batchSizes = [3];
    const tomorrow = new Date(NIGHT.getTime() + DAY_MS);
    vi.setSystemTime(tomorrow);
    expect((await runDbRetentionTick(tomorrow)).ran).toBe(true);
  });

  it("a trava é por dia em que a janela abriu, mesmo cruzando a meia-noite UTC", () => {
    process.env.DB_RETENTION_WORKER_HOUR_UTC = "23";
    const before = new Date("2026-10-05T23:30:00.000Z");
    const after = new Date("2026-10-06T01:30:00.000Z");
    expect(isInsideRetentionWindow(before)).toBe(true);
    expect(isInsideRetentionWindow(after)).toBe(true);
    expect(retentionClaimKey(after)).toBe(retentionClaimKey(before));
    expect(retentionClaimKey(before)).toBe("db-retention:2026-10-05");
  });

  it("DB_RETENTION_WORKER=0 desliga", async () => {
    process.env.DB_RETENTION_WORKER = "0";
    expect(await runDbRetentionTick(NIGHT)).toEqual({ ran: false, reason: "disabled" });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it("índice ausente: avisa no log e não apaga", async () => {
    indexesPresent = false;
    const out = await runDbRetentionTick(NIGHT);
    expect(out.ran).toBe(true);
    expect(h.executeRaw).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ table: "meta_webhook_events", deleted: 0 }),
      expect.stringContaining("tabela pulada"),
    );
  });

  it("teto de lotes por noite vem do env", async () => {
    process.env.DB_RETENTION_WORKER_MAX_BATCHES = "1";
    batchSizes = [5_000, 5_000];
    const out = await runDbRetentionTick(NIGHT);
    expect(out.ran && out.run.targets[0]).toMatchObject({ deleted: 5_000, hitCap: true });
  });
});
