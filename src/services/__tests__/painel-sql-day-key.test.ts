/**
 * Dia civil vindo do SQL (`localTs(col)::date`, `deal_stage_daily_snapshots.date`).
 *
 * O Prisma devolve coluna `date` como `Date` à meia-noite UTC daquele dia.
 * Passar esse valor por `dayKeyFromDate` (que converte para São Paulo, UTC-3)
 * recuava todo dia em um: com `period=today` o `volume.byDay` saía 0/0 enquanto
 * `started`/`finished` davam 14/6 (auditoria de produção, 12/10), e a evolução
 * diária não achava o snapshot de hoje.
 *
 * Sem banco: o `$queryRaw` simula o Postgres — agrupa pelo dia civil de SP e
 * devolve o dia como o Prisma devolve (`Date` à meia-noite UTC).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Conv = {
  id: string;
  createdAt: Date;
  closedAt: Date | null;
  status: "OPEN" | "RESOLVED";
  hasHumanReply: boolean;
};

const h = vi.hoisted(() => ({
  convs: [] as Conv[],
  snapshots: [] as { date: Date; stageId: string; openCount: number }[],
  from: new Date(),
  to: new Date(),
}));

const SP_OFFSET_MS = 3 * 60 * 60 * 1000;
/** `localTs(col)::date` como o Prisma devolve: meia-noite UTC do dia civil de SP. */
const pgLocalDate = (d: Date) =>
  new Date(`${new Date(d.getTime() - SP_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00.000Z`);
const inRange = (d: Date | null) => !!d && d >= h.from && d <= h.to;

function groupByDay(items: Date[]): { d: Date; c: bigint }[] {
  const map = new Map<number, number>();
  for (const at of items) {
    const key = pgLocalDate(at).getTime();
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([t, c]) => ({ d: new Date(t), c: BigInt(c) }));
}

function answer(sql: string): unknown[] {
  const created = h.convs.filter((c) => inRange(c.createdAt));
  const finished = h.convs.filter((c) => c.status === "RESOLVED" && inRange(c.closedAt));
  if (sql.includes('AS "stillOpen"')) {
    const open = created.filter((c) => c.status !== "RESOLVED" && !c.closedAt);
    return [
      {
        started: BigInt(created.length),
        stillOpen: BigInt(open.length),
        openStarted: BigInt(open.filter((c) => c.hasHumanReply).length),
        openWaiting: BigInt(open.filter((c) => !c.hasHumanReply).length),
        resolved: BigInt(created.filter((c) => c.status === "RESOLVED").length),
      },
    ];
  }
  if (sql.includes('AS "fromStarted"')) {
    return [
      {
        finished: BigInt(finished.length),
        fromStarted: BigInt(finished.filter((c) => inRange(c.createdAt)).length),
      },
    ];
  }
  if (sql.includes("::date AS d") && sql.includes('conv."createdAt" AT TIME ZONE')) {
    return groupByDay(created.map((c) => c.createdAt));
  }
  if (sql.includes("::date AS d") && sql.includes('conv."closedAt" AT TIME ZONE')) {
    return groupByDay(finished.map((c) => c.closedAt!));
  }
  if (sql.includes("ORDER BY date ASC")) {
    const sorted = [...h.snapshots].sort((a, b) => a.date.getTime() - b.date.getTime());
    return sorted.slice(0, 1).map((r) => ({ date: r.date }));
  }
  if (sql.includes('SELECT date, "stageId", "openCount"')) return h.snapshots;
  return [];
}

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    // `$queryRaw(Prisma.sql`…`)` ou como tag (`$queryRaw`…``, recebe os pedaços).
    $queryRaw: async (q: { sql: string } | TemplateStringsArray) =>
      answer(Array.isArray(q) ? q.join("?") : (q as { sql: string }).sql),
    stage: {
      findMany: async () => [
        { id: "s1", name: "Novo", color: "#000", isWon: false, isLost: false, pipelineId: "p1", position: 0 },
      ],
    },
  }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/prisma-replica", () => ({
  isReplicaActive: () => false,
  isReplicaTripped: () => false,
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/services/painel-agora", () => ({ getPainelAgora: vi.fn() }));
vi.mock("@/services/painel-hours", () => ({ loadPainelHours: vi.fn() }));
vi.mock("@/services/painel-snapshots", () => ({ ensureTodayDealStageSnapshot: vi.fn(async () => ({})) }));
vi.mock("@/services/dashboard", () => ({ SOURCE_NONE: "__none__" }));
vi.mock("@/services/kanban-filters", () => ({ buildDealWhereFromFilters: async () => [] }));

import { getPainelEvolution } from "@/services/painel-deals";
import { computePainelRange, dayKeyFromSqlDate } from "@/services/painel-period";
import { getPainelVolume } from "@/services/painel-service";

/** 12/10/2026 12:00 em São Paulo. */
const NOW = new Date("2026-10-12T15:00:00.000Z");
/** Hora civil de SP do dia 12/10 → instante UTC. */
const sp = (hh: number, mm = 0, day = 12) =>
  new Date(Date.UTC(2026, 9, day, hh + 3, mm));

function conv(id: string, createdAt: Date, closedAt: Date | null, hasHumanReply = false): Conv {
  return { id, createdAt, closedAt, status: closedAt ? "RESOLVED" : "OPEN", hasHumanReply };
}

/**
 * Caso da auditoria: 14 iniciadas hoje (4 já encerradas, 10 abertas aguardando),
 * 6 encerradas hoje (4 delas iniciadas hoje + 2 que vieram de antes).
 */
function auditFixture(): Conv[] {
  const out: Conv[] = [];
  // 4 iniciadas e encerradas hoje — uma às 00:10 de SP (03:10 UTC).
  out.push(conv("r1", sp(0, 10), sp(9)));
  out.push(conv("r2", sp(8), sp(9, 30)));
  out.push(conv("r3", sp(9), sp(10)));
  out.push(conv("r4", sp(10), sp(11)));
  // 10 abertas iniciadas hoje, ainda sem resposta humana.
  for (let i = 0; i < 10; i++) out.push(conv(`o${i}`, sp(9 + (i % 3), i), null));
  // 2 iniciadas ontem e encerradas hoje (carryover).
  out.push(conv("c1", sp(14, 0, 11), sp(9, 5)));
  // Ontem 22:00 em SP = hoje 01:00 UTC: fora do período "hoje" de SP.
  out.push(conv("c2", sp(22, 0, 11), sp(9, 10)));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.convs = [];
  h.snapshots = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dayKeyFromSqlDate", () => {
  it("usa o dia que o SQL já calculou, sem converter de novo para SP", () => {
    expect(dayKeyFromSqlDate(new Date("2026-10-12T00:00:00.000Z"))).toBe("2026-10-12");
    expect(dayKeyFromSqlDate("2026-10-12")).toBe("2026-10-12");
  });
});

describe("volume.byDay soma exatamente os totais do período", () => {
  it("period=today: byDay do dia corrente = started/finished (14/6), não 0/0", async () => {
    const range = computePainelRange("today", null, null, NOW);
    h.from = range.from;
    h.to = range.to;
    h.convs = auditFixture();

    const v = await getPainelVolume(range, "business");

    expect(v.started.value).toBe(14);
    expect(v.finished.value).toBe(6);
    expect(v.stillOpen.value).toBe(10);
    expect(v.partition.finishedFromStarted).toBe(4);
    expect(v.partition.finishedCarryover).toBe(2);
    expect(v.byDay).toEqual([
      { date: "2026-10-12", started: 14, finished: 6, incomplete: true },
    ]);
  });

  it("vários dias (last_7, relógio corrido): cada dia no seu dia civil de SP e a soma bate", async () => {
    const range = computePainelRange("last_7", null, null, NOW);
    h.from = range.from;
    h.to = range.to;
    h.convs = [
      ...auditFixture(),
      // 23:30 de SP em 08/10 = 02:30 UTC de 09/10: conta em 08/10.
      conv("x1", sp(23, 30, 8), sp(23, 45, 8)),
      // Primeiro dia do período (06/10), 00:05 de SP.
      conv("x2", sp(0, 5, 6), null),
    ];

    const v = await getPainelVolume(range, "elapsed");
    const sum = (k: "started" | "finished") => v.byDay.reduce((s, d) => s + d[k], 0);

    expect(v.byDay.map((d) => d.date)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
    expect(sum("started")).toBe(v.started.value);
    expect(sum("finished")).toBe(v.finished.value);
    const byDate = Object.fromEntries(v.byDay.map((d) => [d.date, d]));
    expect(byDate["2026-10-06"]).toMatchObject({ started: 1, finished: 0 });
    expect(byDate["2026-10-08"]).toMatchObject({ started: 1, finished: 1 });
    expect(byDate["2026-10-09"]).toMatchObject({ started: 0, finished: 0 });
    expect(byDate["2026-10-11"]).toMatchObject({ started: 2, finished: 0 });
    expect(byDate["2026-10-12"]).toMatchObject({ started: 14, finished: 6, incomplete: true });
  });
});

describe("evolução diária lê o snapshot no dia em que foi gravado", () => {
  it("period=today: o snapshot de hoje vira o ponto de hoje", async () => {
    h.snapshots = [
      { date: new Date("2026-10-12T00:00:00.000Z"), stageId: "s1", openCount: 7 },
    ];
    const range = computePainelRange("today", null, null, NOW);
    const ev = await getPainelEvolution({ range, pipelineIds: ["p1"] } as never);

    expect(ev.available).toBe(true);
    expect(ev.retainedFrom).toBe("2026-10-12");
    expect(ev.points).toEqual([
      { date: "2026-10-12", incomplete: true, byStage: { s1: 7 } },
    ]);
  });
});
