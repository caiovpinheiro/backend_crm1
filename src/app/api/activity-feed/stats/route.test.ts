/**
 * GET /api/activity-feed/stats — janela pedida, uma varredura e cache.
 *
 * Antes: sem filtro de período o Dashboard agregava 30 dias (665 mil eventos,
 * 1,8 s) em seis consultas a cada abertura, sem cache. Agora a rota aceita
 * `period` / `from` / `to`, faz UMA consulta (`GROUPING SETS`) e guarda o
 * resultado por org + janela (cache real, fallback em memória, sem Redis).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "ADMIN" as "ADMIN" | "MANAGER" | "MEMBER",
  orgId: "org_1",
  rows: [] as unknown[],
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) =>
    cb({ user: { id: "u1", role: h.role, organizationId: h.orgId, isSuperAdmin: false } }),
}));
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({ $queryRaw: h.queryRaw }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => h.orgId }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { GET } from "@/app/api/activity-feed/stats/route";

/** 12/10/2026 12:00 em São Paulo. */
const NOW = new Date("2026-10-12T15:00:00.000Z");
let seq = 0;

const req = (qs: Record<string, string> = {}) =>
  new Request(`https://api.test/api/activity-feed/stats?${new URLSearchParams(qs)}`);

/** Linhas do `GROUPING SETS` como o Postgres/Prisma devolvem. */
function groupingRows() {
  const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
  return [
    { kind: "actor", day: null, actorType: "HUMAN", entityType: null, type: null, hour: null, count: 5n },
    { kind: "actor", day: null, actorType: "AI", entityType: null, type: null, hour: null, count: 3n },
    { kind: "entity", day: null, actorType: null, entityType: "CONVERSATION", type: null, hour: null, count: 6n },
    { kind: "entity", day: null, actorType: null, entityType: "DEAL", type: null, hour: null, count: 2n },
    { kind: "type", day: null, actorType: null, entityType: null, type: "MESSAGE_SENT", hour: null, count: 2n },
    { kind: "type", day: null, actorType: null, entityType: null, type: "CONVERSATION_TABULATED", hour: null, count: 6n },
    { kind: "day", day: day("2026-10-12"), actorType: "HUMAN", entityType: null, type: null, hour: null, count: 5n },
    { kind: "day", day: day("2026-10-12"), actorType: "AI", entityType: null, type: null, hour: null, count: 3n },
    { kind: "hour", day: null, actorType: null, entityType: null, type: null, hour: 9, count: 8n },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.role = "ADMIN";
  h.orgId = `org_${++seq}`;
  h.queryRaw.mockReset();
  h.queryRaw.mockImplementation(async () => groupingRows());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/activity-feed/stats", () => {
  it("period=today: agrega só o dia de hoje (SP) em UMA consulta e devolve o contrato", async () => {
    const res = await GET(req({ period: "today" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const q = h.queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    const sql = q.sql.replace(/\s+/g, " ");
    expect(sql).toContain("GROUP BY GROUPING SETS");
    expect(sql).toContain('"organizationId" = ?');
    expect(sql).toContain('"occurredAt" >= ? AND "occurredAt" <= ?');
    expect(q.values).toEqual(
      expect.arrayContaining([
        h.orgId,
        new Date("2026-10-12T03:00:00.000Z"),
        new Date("2026-10-13T02:59:59.999Z"),
      ]),
    );

    expect(body.window).toEqual({
      from: "2026-10-12T03:00:00.000Z",
      to: "2026-10-13T02:59:59.999Z",
    });
    expect(body.totals).toEqual({
      total: 8,
      byActorType: { HUMAN: 5, AI: 3 },
      byEntityType: { CONVERSATION: 6, DEAL: 2 },
      byType: [
        { type: "CONVERSATION_TABULATED", count: 6 },
        { type: "MESSAGE_SENT", count: 2 },
      ],
    });
    // Um dia (o civil de SP), não dois dias UTC.
    expect(body.timeline).toEqual([{ day: "2026-10-12", count: 8 }]);
    expect(body.timelineByActor).toEqual([
      { day: "2026-10-12", HUMAN: 5, AI: 3, AUTOMATION: 0, INTEGRATION: 0, SYSTEM: 0 },
    ]);
    expect(body.hourly).toHaveLength(24);
    expect(body.hourly[9]).toEqual({ hour: 9, count: 8 });
  });

  it("from/to (e dateFrom/dateTo) definem a janela; AAAA-MM-DD é o dia civil de SP", async () => {
    await GET(req({ from: "2026-10-10", to: "2026-10-11" }));
    const v1 = (h.queryRaw.mock.calls[0]![0] as { values: unknown[] }).values;
    expect(v1).toEqual(
      expect.arrayContaining([
        new Date("2026-10-10T03:00:00.000Z"),
        new Date("2026-10-12T02:59:59.999Z"),
      ]),
    );

    await GET(
      req({ dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-10-02T00:00:00.000Z" }),
    );
    const v2 = (h.queryRaw.mock.calls[1]![0] as { values: unknown[] }).values;
    expect(v2).toEqual(
      expect.arrayContaining([
        new Date("2026-10-01T00:00:00.000Z"),
        new Date("2026-10-02T00:00:00.000Z"),
      ]),
    );
  });

  it("sem parâmetros mantém os últimos 30 dias (contrato antigo)", async () => {
    const body = await (await GET(req())).json();
    expect(new Date(body.window.to).getTime()).toBe(NOW.getTime());
    expect(NOW.getTime() - new Date(body.window.from).getTime()).toBe(30 * 86_400_000);
  });

  it("cache por org + janela: o 2º pedido igual não consulta o banco", async () => {
    const first = await GET(req({ period: "today" }));
    const second = await GET(req({ period: "today" }));
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(await second.json()).toEqual(await first.json());
    expect(second.headers.get("Server-Timing")).toMatch(/cache;dur=[\d.]+;desc="hit"/);

    // Outra janela, outra chave.
    await GET(req({ period: "yesterday" }));
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("parâmetros inválidos: 400 sem consultar", async () => {
    const invalid: Record<string, string>[] = [
      { period: "ontem" },
      { from: "abc" },
      { from: "2026-10-12", to: "2026-10-01" },
    ];
    for (const qs of invalid) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
    }
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("MEMBER: 403", async () => {
    h.role = "MEMBER";
    const res = await GET(req({ period: "today" }));
    expect(res.status).toBe(403);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});
