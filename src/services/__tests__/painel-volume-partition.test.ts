/**
 * Partição do período em `getPainelVolume`.
 *
 * Sem banco: o `$queryRaw` é simulado por um classificador de referência que
 * aplica, sobre 10 conversas, os MESMOS predicados do SQL (ver as consultas em
 * `getPainelVolume`). O teste valida (1) a relação entre os KPIs e (2) que o
 * SQL carrega os predicados que o classificador assume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Conv = {
  id: string;
  createdAt: Date;
  closedAt: Date | null;
  status: "OPEN" | "RESOLVED" | "PENDING" | "SNOOZED";
  hasHumanReply: boolean;
};

const h = vi.hoisted(() => ({
  convs: [] as Conv[],
  sqls: [] as string[],
  from: new Date(),
  to: new Date(),
}));

const inRange = (d: Date | null) => !!d && d >= h.from && d <= h.to;

function answer(sql: string): unknown[] {
  h.sqls.push(sql);
  const created = h.convs.filter((c) => inRange(c.createdAt));
  const isOpen = (c: Conv) => c.status !== "RESOLVED" && c.closedAt === null;
  if (sql.includes('AS "stillOpen"')) {
    return [
      {
        started: BigInt(created.length),
        stillOpen: BigInt(created.filter(isOpen).length),
        openStarted: BigInt(created.filter((c) => isOpen(c) && c.hasHumanReply).length),
        openWaiting: BigInt(created.filter((c) => isOpen(c) && !c.hasHumanReply).length),
        resolved: BigInt(created.filter((c) => c.status === "RESOLVED").length),
      },
    ];
  }
  if (sql.includes('AS "fromStarted"')) {
    const fin = h.convs.filter((c) => c.status === "RESOLVED" && inRange(c.closedAt));
    return [
      {
        finished: BigInt(fin.length),
        fromStarted: BigInt(fin.filter((c) => inRange(c.createdAt)).length),
      },
    ];
  }
  return [];
}

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    $queryRaw: async (q: { sql: string }) => answer(q.sql),
  }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/prisma-replica", () => ({
  isReplicaActive: () => false,
  isReplicaTripped: () => false,
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/services/painel-agora", () => ({ getPainelAgora: vi.fn() }));
vi.mock("@/services/painel-hours", () => ({ loadPainelHours: vi.fn() }));

import { getPainelVolume } from "@/services/painel-service";

const D = (iso: string) => new Date(`${iso}T12:00:00Z`);

// Período: 08/09 a 01/10. "antes" = agosto; "depois" = 03/10.
const FROM = new Date("2026-09-08T00:00:00Z");
const TO = new Date("2026-10-01T23:59:59Z");

const FIXTURE: Conv[] = [
  // iniciada e encerrada no período
  { id: "a1", createdAt: D("2026-09-10"), closedAt: D("2026-09-11"), status: "RESOLVED", hasHumanReply: true },
  // iniciadas ANTES e encerradas no período (entram em `finished`, não em `started`)
  { id: "a2", createdAt: D("2026-08-20"), closedAt: D("2026-09-12"), status: "RESOLVED", hasHumanReply: true },
  { id: "a3", createdAt: D("2026-08-25"), closedAt: D("2026-09-15"), status: "RESOLVED", hasHumanReply: true },
  { id: "a4", createdAt: D("2026-08-28"), closedAt: D("2026-09-20"), status: "RESOLVED", hasHumanReply: false },
  // iniciada no período, aberta, aguardando 1ª resposta humana
  { id: "a5", createdAt: D("2026-09-22"), closedAt: null, status: "OPEN", hasHumanReply: false },
  // iniciada no período, aberta e já atendida
  { id: "a6", createdAt: D("2026-09-23"), closedAt: null, status: "OPEN", hasHumanReply: true },
  // reabertura: encerrada e reaberta (OPEN limpa closedAt) -> conta uma vez, como aberta
  { id: "a7", createdAt: D("2026-09-24"), closedAt: null, status: "OPEN", hasHumanReply: true },
  // iniciada no período e encerrada DEPOIS dele: não está em `finished`
  { id: "a8", createdAt: D("2026-09-30"), closedAt: D("2026-10-03"), status: "RESOLVED", hasHumanReply: true },
  // iniciada no período, PENDING com closedAt de encerramento anterior: o resto
  { id: "a9", createdAt: D("2026-09-25"), closedAt: D("2026-09-26"), status: "PENDING", hasHumanReply: true },
  // iniciada antes e ainda aberta: fora de tudo
  { id: "a10", createdAt: D("2026-08-01"), closedAt: null, status: "OPEN", hasHumanReply: true },
];

describe("getPainelVolume — partição do período (10 conversas)", () => {
  beforeEach(() => {
    h.convs = FIXTURE;
    h.sqls.length = 0;
    h.from = FROM;
    h.to = TO;
  });

  it("a coorte started se decompõe exatamente e finished NÃO é subconjunto dela", async () => {
    const v = await getPainelVolume({ from: FROM, to: TO }, "elapsed");

    expect(v.started.value).toBe(6); // a1, a5, a6, a7, a8, a9
    expect(v.finished.value).toBe(4); // a1, a2, a3, a4
    expect(v.stillOpen.value).toBe(3); // a5, a6, a7
    expect(v.openWaiting.value).toBe(1); // a5
    expect(v.openStarted.value).toBe(2); // a6, a7

    // Coorte: started = resolved + open + other; open = openStarted + openWaiting.
    expect(v.partition).toEqual({
      resolved: 2, // a1, a8
      open: 3,
      other: 1, // a9
      finishedFromStarted: 1, // a1
      finishedCarryover: 3, // a2, a3, a4
    });
    expect(v.partition.resolved + v.partition.open + v.partition.other).toBe(v.started.value);
    expect(v.openStarted.value + v.openWaiting.value).toBe(v.stillOpen.value);
    expect(v.partition.open).toBe(v.stillOpen.value);

    // Fluxo: finished = finishedFromStarted + finishedCarryover.
    expect(v.partition.finishedFromStarted + v.partition.finishedCarryover).toBe(v.finished.value);

    // O que o painel somava: finished + stillOpen (4 + 3 = 7) != started (6).
    expect(v.finished.value + v.stillOpen.value).not.toBe(v.started.value);
  });

  it("o SQL carrega os predicados que a partição assume", async () => {
    await getPainelVolume({ from: FROM, to: TO }, "elapsed");
    const cohort = h.sqls.find((s) => s.includes('AS "stillOpen"'))!;
    const flow = h.sqls.find((s) => s.includes('AS "fromStarted"'))!;

    // Coorte: criadas no período; resolved por status; aberta = não RESOLVED e sem closedAt.
    expect(cohort).toMatch(/conv\."createdAt" >= \? AND conv\."createdAt" <= \?/);
    expect(cohort).toMatch(
      /COUNT\(\*\) FILTER \(\s*WHERE conv\.status = 'RESOLVED'::"ConversationStatus"\s*\)::bigint AS resolved/,
    );
    expect(cohort).toMatch(/status <> 'RESOLVED'::"ConversationStatus" AND conv\."closedAt" IS NULL/);

    // Fluxo: encerradas no período por closedAt (sem filtro de criação no WHERE) e
    // a fatia criada no período só no FILTER.
    expect(flow).toMatch(/conv\.status = 'RESOLVED'::"ConversationStatus"/);
    expect(flow).toMatch(/conv\."closedAt" >= \? AND conv\."closedAt" <= \?/);
    expect(flow).toMatch(
      /FILTER \(\s*WHERE conv\."createdAt" >= \? AND conv\."createdAt" <= \?\s*\)::bigint AS "fromStarted"/,
    );
    const where = flow.slice(flow.indexOf('WHERE conv."organizationId"'));
    expect(where).not.toMatch(/createdAt/);
  });

  it("período vazio zera a partição", async () => {
    h.convs = [];
    const v = await getPainelVolume({ from: FROM, to: TO }, "elapsed");
    expect(v.partition).toEqual({
      resolved: 0,
      open: 0,
      other: 0,
      finishedFromStarted: 0,
      finishedCarryover: 0,
    });
    expect(v.empty).toBe(true);
  });
});
