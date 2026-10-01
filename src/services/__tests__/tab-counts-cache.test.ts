/**
 * Contadores do inbox com cache separado (banco falso, sem Redis).
 *
 * - Histórica (todos/resolvidos/finalizados): chave própria, TTL 10 min.
 * - Ativa (entrada…ligar): chave com a versão da org, TTL 90 s.
 * - Expirar ou invalidar só a ativa não roda a consulta histórica.
 * - Números iguais aos de antes da separação.
 * - Stale-while-revalidate: vencida, a chave devolve o número antigo na
 *   hora e recalcula em segundo plano uma vez; depois do teto (ativa
 *   180 s, histórica 15 min) ou de uma invalidação, recalcula antes de
 *   responder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn(),
    conversationCount: vi.fn(),
    userFindMany: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    conversation: { count: h.conversationCount },
    contact: { count: vi.fn() },
    user: { findMany: h.userFindMany },
  },
  allocateOrgNumber: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn(),
  userIdForFk: vi.fn(),
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingFor: vi.fn(async () => null),
  getOrgSetting: vi.fn(async () => null),
}));

import { invalidateInboxTabCounts } from "@/lib/cache/keys";
import { runWithContext } from "@/lib/request-context";
import { getTabCounts } from "@/services/conversations";

type Row = Record<string, number>;

const HIST_ROW: Row = { todos: 9_999, resolvidos: 30, finalizados: 20 };
const ACTIVE_ROW: Row = {
  entrada: 1,
  esperando: 2,
  respondidas: 3,
  agente_ia: 4,
  automacao: 5,
  erro: 6,
  abertas: 21,
  ligar: 7,
};

function sqlOf(call: unknown[]): string {
  const [strings] = call as [TemplateStringsArray];
  return strings.join("?");
}

const isHist = (sql: string) => sql.includes("AS resolvidos");
const isActive = (sql: string) => sql.includes("AS entrada");

function histCalls() {
  return h.queryRaw.mock.calls.filter((c) => isHist(sqlOf(c))).length;
}
function activeCalls() {
  return h.queryRaw.mock.calls.filter((c) => isActive(sqlOf(c))).length;
}

let activeRow: Row;

/** Deixa a revalidação em segundo plano (SWR) terminar. */
async function flushBackground() {
  await vi.advanceTimersByTimeAsync(0);
}

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId } as Parameters<typeof runWithContext>[0],
    fn,
  ) as Promise<T>;
}

beforeEach(() => {
  vi.useFakeTimers();
  activeRow = { ...ACTIVE_ROW };
  h.queryRaw.mockReset();
  h.conversationCount.mockReset();
  h.userFindMany.mockReset().mockResolvedValue([]);
  h.queryRaw.mockImplementation(async (...call: unknown[]) => {
    const sql = sqlOf(call);
    if (isHist(sql)) return [{ ...HIST_ROW }];
    if (isActive(sql)) return [{ ...activeRow }];
    throw new Error(`query inesperada: ${sql.slice(0, 80)}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getTabCounts — cache histórico separado", () => {
  it("ADMIN: mesmos números de antes (todos = abertas + resolvidos + finalizados)", async () => {
    const counts = await withOrg("org-admin", () => getTabCounts({}, null));
    expect(counts).toEqual({
      entrada: 1,
      esperando: 2,
      respondidas: 3,
      agente_ia: 4,
      automacao: 5,
      resolvidos: 30,
      finalizados: 20,
      erro: 6,
      todos: 21 + 30 + 20,
      abertas: 21,
      ligar: 7,
    });
    expect(histCalls()).toBe(1);
    expect(activeCalls()).toBe(1);
  });

  it("MEMBER: todos vem da consulta histórica, como antes", async () => {
    const counts = await withOrg("org-member", () =>
      getTabCounts({}, ["entrada", "esperando"]),
    );
    expect(counts.todos).toBe(9_999);
    expect(counts.resolvidos).toBe(30);
    expect(counts.abertas).toBe(21);
  });

  it("expiração só da ativa (90 s) não roda a consulta histórica", async () => {
    await withOrg("org-ttl", () => getTabCounts({}, null));
    expect(histCalls()).toBe(1);
    expect(activeCalls()).toBe(1);

    // Dentro dos 90 s: tudo do cache.
    await vi.advanceTimersByTimeAsync(60_000);
    await withOrg("org-ttl", () => getTabCounts({}, null));
    expect(histCalls()).toBe(1);
    expect(activeCalls()).toBe(1);

    // Ativa venceu; histórica (10 min) continua. A requisição recebe o
    // número antigo na hora e só a consulta ativa roda, em segundo plano.
    activeRow = { ...ACTIVE_ROW, entrada: 11, abertas: 25 };
    await vi.advanceTimersByTimeAsync(31_000);
    const stale = await withOrg("org-ttl", () => getTabCounts({}, null));
    expect(stale.entrada).toBe(1);
    await flushBackground();
    expect(histCalls()).toBe(1);
    expect(activeCalls()).toBe(2);

    // Revalidado: a leitura seguinte já vem com os números novos.
    const counts = await withOrg("org-ttl", () => getTabCounts({}, null));
    expect(histCalls()).toBe(1);
    expect(activeCalls()).toBe(2);
    expect(counts.entrada).toBe(11);
    expect(counts.resolvidos).toBe(30);
    expect(counts.todos).toBe(25 + 30 + 20);

    // Depois de 10 min a histórica também recalcula (ativa passou do teto
    // de 180 s: recalcula antes de responder; a histórica, vencida dentro
    // do teto dela, revalida em segundo plano).
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await withOrg("org-ttl", () => getTabCounts({}, null));
    await flushBackground();
    expect(histCalls()).toBe(2);
    expect(activeCalls()).toBe(3);
  });

  it("vencida: devolve o número antigo na hora e revalida uma vez só", async () => {
    await withOrg("org-swr", () => getTabCounts({}, null));
    activeRow = { ...ACTIVE_ROW, entrada: 50 };
    await vi.advanceTimersByTimeAsync(91_000);

    // A consulta em segundo plano demora: 5 leituras vencidas no meio.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.queryRaw.mockImplementation(async (...call: unknown[]) => {
      const sql = sqlOf(call);
      if (isHist(sql)) return [{ ...HIST_ROW }];
      if (isActive(sql)) {
        await gate;
        return [{ ...activeRow }];
      }
      throw new Error(`query inesperada: ${sql.slice(0, 80)}`);
    });

    for (let i = 0; i < 5; i++) {
      const counts = await withOrg("org-swr", () => getTabCounts({}, null));
      expect(counts.entrada).toBe(1);
      await flushBackground();
    }
    expect(activeCalls()).toBe(2);

    release();
    await flushBackground();
    const fresh = await withOrg("org-swr", () => getTabCounts({}, null));
    expect(fresh.entrada).toBe(50);
    expect(activeCalls()).toBe(2);
    expect(histCalls()).toBe(1);
  });

  it("passado o teto de 180 s a requisição espera o número novo", async () => {
    await withOrg("org-teto", () => getTabCounts({}, null));
    activeRow = { ...ACTIVE_ROW, entrada: 77 };
    await vi.advanceTimersByTimeAsync(181_000);

    const counts = await withOrg("org-teto", () => getTabCounts({}, null));
    expect(counts.entrada).toBe(77);
    expect(activeCalls()).toBe(2);
  });

  it("mudança de aba (invalidação) não serve o número antigo", async () => {
    await withOrg("org-rw", () => getTabCounts({}, null));
    activeRow = { ...ACTIVE_ROW, entrada: 9 };

    await invalidateInboxTabCounts("org-rw");
    const counts = await withOrg("org-rw", () => getTabCounts({}, null));
    expect(counts.entrada).toBe(9);
  });

  it("consulta em segundo plano falhando mantém o número antigo", async () => {
    await withOrg("org-err", () => getTabCounts({}, null));
    await vi.advanceTimersByTimeAsync(91_000);
    h.queryRaw.mockImplementation(async () => {
      throw new Error("db fora");
    });
    h.conversationCount.mockRejectedValue(new Error("db fora"));

    const counts = await withOrg("org-err", () => getTabCounts({}, null));
    await flushBackground();
    expect(counts.entrada).toBe(1);
    const again = await withOrg("org-err", () => getTabCounts({}, null));
    expect(again.entrada).toBe(1);
  });

  it("invalidação por mudança de aba apaga só a chave ativa", async () => {
    await withOrg("org-inv", () => getTabCounts({}, null));
    await invalidateInboxTabCounts("org-inv");
    await withOrg("org-inv", () => getTabCounts({}, null));

    expect(histCalls()).toBe(1);
    expect(activeCalls()).toBe(2);
  });

  it("fallback sequencial segue a mesma separação", async () => {
    // One-SQL falha → COUNT por aba. Histórica: 2 COUNT DISTINCT
    // (resolvidos, finalizados). Ativa: 8 conversation.count.
    let distinctCounts = 0;
    h.queryRaw.mockImplementation(async (...call: unknown[]) => {
      const sql = sqlOf(call);
      if (isHist(sql) || isActive(sql)) throw new Error("one-SQL falhou");
      if (sql.includes("AS n")) {
        distinctCounts += 1;
        return [{ n: 5 }];
      }
      throw new Error(`query inesperada: ${sql.slice(0, 80)}`);
    });
    h.conversationCount.mockResolvedValue(1);

    const first = await withOrg("org-fb", () => getTabCounts({}, null));
    expect(first).toEqual({
      entrada: 1,
      esperando: 1,
      respondidas: 1,
      agente_ia: 1,
      automacao: 1,
      resolvidos: 5,
      finalizados: 5,
      erro: 1,
      todos: 1 + 5 + 5,
      abertas: 1,
      ligar: 1,
    });
    expect(distinctCounts).toBe(2);
    expect(h.conversationCount).toHaveBeenCalledTimes(8);

    await invalidateInboxTabCounts("org-fb");
    await withOrg("org-fb", () => getTabCounts({}, null));
    expect(distinctCounts).toBe(2);
    expect(h.conversationCount).toHaveBeenCalledTimes(16);
  });
});
