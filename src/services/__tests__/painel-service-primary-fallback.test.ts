/**
 * Fallback do Painel de Atendimentos para o banco principal sem réplica
 * (`PAINEL_PRIMARY_FALLBACK`). Sem Redis no teste: cache e lock em memória.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  delete process.env.REDIS_CACHE_URL;
  return {
    replicaQuery: vi.fn(),
    txCalls: 0,
    active: 0,
    maxActive: 0,
    txOptions: [] as unknown[],
    setTimeoutSql: [] as { sql: string; values: unknown[] }[],
    txQueryRaw: vi.fn(),
    txDelayMs: 0,
    txError: null as Error | null,
    logError: vi.fn(),
  };
});

/** Cliente da transação: qualquer `tx.<model>.<método>` devolve lista vazia. */
function makeTx() {
  const model = new Proxy({}, { get: () => async () => [] });
  return new Proxy(
    {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.setTimeoutSql.push({ sql: strings.join("?"), values });
        return 1;
      },
      $queryRaw: h.txQueryRaw,
    } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : model) },
  );
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>, opts: unknown) => {
      h.txCalls += 1;
      h.txOptions.push(opts);
      h.active += 1;
      h.maxActive = Math.max(h.maxActive, h.active);
      try {
        if (h.txDelayMs) await new Promise((r) => setTimeout(r, h.txDelayMs));
        if (h.txError) throw h.txError;
        return await fn(makeTx());
      } finally {
        h.active -= 1;
      }
    },
  },
}));
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({ $queryRaw: h.replicaQuery }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/prisma-replica", () => ({
  isReplicaActive: () => false,
  isReplicaTripped: () => false,
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org_fallback",
  getOrgIdOrNull: () => "org_fallback",
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/services/painel-agora", () => ({ getPainelAgora: vi.fn() }));
vi.mock("@/services/painel-hours", () => ({
  loadPainelHours: async () => DEFAULT_BUSINESS_HOURS,
}));

import { DEFAULT_BUSINESS_HOURS, computePainelRange } from "@/services/painel-period";
import {
  PAINEL_NO_REPLICA_MESSAGE,
  PAINEL_PRIMARY_TIMEOUT_MESSAGE,
  getPainelService,
  type PainelServiceSection,
} from "@/services/painel-service";
import { painelPrimaryTimeoutMs } from "@/services/painel-primary-fallback";

const REPLICA_ONLY: PainelServiceSection[] = [
  "tempo",
  "heatmap",
  "byDepartment",
  "connections",
  "attendants",
  "channels",
];

// Cache em memória dura o arquivo inteiro: cada teste usa o seu período.
let day = 1;
function freshRange() {
  const d = `2026-09-${String(day++).padStart(2, "0")}`;
  return computePainelRange("custom", d, d);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  h.replicaQuery.mockReset();
  h.txQueryRaw.mockReset();
  h.txQueryRaw.mockResolvedValue([]);
  h.txCalls = 0;
  h.active = 0;
  h.maxActive = 0;
  h.txOptions = [];
  h.setTimeoutSql = [];
  h.txDelayMs = 0;
  h.txError = null;
  h.logError.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PAINEL_PRIMARY_FALLBACK desligado (padrão)", () => {
  it("sem réplica continua no_replica e não toca no primário", async () => {
    const out = await getPainelService(freshRange(), "elapsed", REPLICA_ONLY);
    for (const key of REPLICA_ONLY) {
      expect(out[key]).toEqual({
        ok: false,
        error: PAINEL_NO_REPLICA_MESSAGE,
        reason: "no_replica",
      });
    }
    expect(h.txCalls).toBe(0);
    expect(h.replicaQuery).not.toHaveBeenCalled();
  });
});

describe("PAINEL_PRIMARY_FALLBACK ligado, sem réplica", () => {
  it("calcula no primário numa transação com statement_timeout local", async () => {
    vi.stubEnv("PAINEL_PRIMARY_FALLBACK", "1");
    vi.stubEnv("PAINEL_PRIMARY_TIMEOUT_MS", "5000");
    const out = await getPainelService(freshRange(), "elapsed", REPLICA_ONLY);

    for (const key of REPLICA_ONLY) expect(out[key].ok).toBe(true);
    // Seção não pedida segue omitida.
    expect(out.exceptions).toEqual({ ok: false, error: "omitido" });
    expect(h.txCalls).toBe(1);
    expect(h.setTimeoutSql).toHaveLength(1);
    expect(h.setTimeoutSql[0].sql).toContain("set_config('statement_timeout', ?, true)");
    expect(h.setTimeoutSql[0].values).toEqual(["5000"]);
    expect(h.txOptions[0]).toMatchObject({ timeout: 7000 });
    // Consultas na transação, nunca no cliente de analytics/réplica.
    expect(h.txQueryRaw).toHaveBeenCalled();
    expect(h.replicaQuery).not.toHaveBeenCalled();
  });

  it("timeout padrão 8000 e valores inválidos voltam ao padrão", () => {
    expect(painelPrimaryTimeoutMs({})).toBe(8000);
    expect(painelPrimaryTimeoutMs({ PAINEL_PRIMARY_TIMEOUT_MS: "abc" })).toBe(8000);
    expect(painelPrimaryTimeoutMs({ PAINEL_PRIMARY_TIMEOUT_MS: "100" })).toBe(8000);
    expect(painelPrimaryTimeoutMs({ PAINEL_PRIMARY_TIMEOUT_MS: "12000" })).toBe(12000);
  });

  it("2 chamadas simultâneas iguais = 1 cálculo; a seguinte vem do cache", async () => {
    vi.stubEnv("PAINEL_PRIMARY_FALLBACK", "true");
    h.txDelayMs = 30;
    const range = freshRange();
    const [a, b] = await Promise.all([
      getPainelService(range, "elapsed", ["heatmap", "connections"]),
      getPainelService(range, "elapsed", ["heatmap", "connections"]),
    ]);
    expect(h.txCalls).toBe(1);
    expect(a.heatmap).toEqual(b.heatmap);
    expect(a.connections.ok).toBe(true);

    await getPainelService(range, "elapsed", ["heatmap", "connections"]);
    expect(h.txCalls).toBe(1);
  });

  it("pedidos diferentes da mesma org nunca calculam ao mesmo tempo (lock por org)", async () => {
    vi.stubEnv("PAINEL_PRIMARY_FALLBACK", "on");
    h.txDelayMs = 30;
    const range = freshRange();
    const [a, b] = await Promise.all([
      getPainelService(range, "elapsed", ["heatmap", "connections"]),
      getPainelService(range, "elapsed", ["tempo", "byDepartment", "attendants", "channels"]),
    ]);
    expect(a.heatmap.ok).toBe(true);
    expect(b.tempo.ok).toBe(true);
    expect(h.txCalls).toBe(2);
    expect(h.maxActive).toBe(1);
  });

  it("timeout no primário vira reason primary_timeout e não vai para o cache", async () => {
    vi.stubEnv("PAINEL_PRIMARY_FALLBACK", "1");
    h.txError = new Error("canceling statement due to statement timeout");
    const range = freshRange();
    const out = await getPainelService(range, "elapsed", ["tempo", "heatmap"]);
    for (const key of ["tempo", "heatmap"] as const) {
      expect(out[key]).toEqual({
        ok: false,
        error: PAINEL_PRIMARY_TIMEOUT_MESSAGE,
        reason: "primary_timeout",
      });
    }
    // Erro do banco só no log.
    expect(JSON.stringify(out)).not.toContain("canceling");
    expect(h.logError).toHaveBeenCalled();

    // Sem cache do erro: a próxima chamada recalcula e dá certo.
    h.txError = null;
    const again = await getPainelService(range, "elapsed", ["tempo", "heatmap"]);
    expect(again.tempo.ok).toBe(true);
    expect(again.heatmap.ok).toBe(true);
    expect(h.txCalls).toBe(2);
  });
});
