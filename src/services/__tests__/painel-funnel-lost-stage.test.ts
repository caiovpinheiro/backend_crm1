/**
 * `funnel.lostStage` em `getPainelFunnel` (provisório até o backfill de status).
 *
 * Sem banco: o Prisma é simulado. O `aggregate` aplica sobre uma lista de negócios
 * os predicados simples que o serviço monta (AND de condições estruturais + etapa);
 * o `$queryRaw` das entradas devolve os eventos do período, como o SQL faria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Deal = {
  id: string;
  stageId: string;
  status: "OPEN" | "WON" | "LOST";
  ownerId: string | null;
  value: number;
};
type Ev = {
  dealId: string;
  stageId: string;
  type: "STAGE_CHANGED" | "CREATED";
  at: Date;
};
type Stage = {
  id: string;
  name: string;
  color: string;
  isWon: boolean;
  isLost: boolean;
  pipelineId: string;
  position: number;
};

const h = vi.hoisted(() => ({
  stages: [] as Stage[],
  deals: [] as Deal[],
  events: [] as Ev[],
  from: new Date(),
  to: new Date(),
  aggregateWheres: [] as unknown[],
  sqls: [] as string[],
}));

type Cond = Record<string, unknown>;

/** Avalia o subconjunto de `DealWhereInput` usado aqui. */
function matches(d: Deal, where: Cond): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND") {
      if (!(v as Cond[]).every((c) => matches(d, c))) return false;
      continue;
    }
    if (k === "stage") {
      const pipelineId = h.stages.find((s) => s.id === d.stageId)?.pipelineId;
      if (!((v as { pipelineId: { in: string[] } }).pipelineId.in).includes(pipelineId!)) {
        return false;
      }
      continue;
    }
    const field = d[k as keyof Deal];
    if (v && typeof v === "object" && "in" in (v as Cond)) {
      if (!((v as { in: unknown[] }).in).includes(field)) return false;
    } else if (field !== v) {
      return false;
    }
  }
  return true;
}

function answerRaw(sql: string): unknown[] {
  h.sqls.push(sql);
  if (sql.includes("DISTINCT ON")) {
    // `entered`: eventos no período, 1ª entrada por (negócio, etapa).
    const seen = new Set<string>();
    const rows: unknown[] = [];
    for (const e of [...h.events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      if (e.at < h.from || e.at > h.to) continue;
      const key = `${e.dealId}|${e.stageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const deal = h.deals.find((d) => d.id === e.dealId)!;
      rows.push({
        dealId: e.dealId,
        stageId: e.stageId,
        enteredAt: e.at,
        value: deal.value,
        ownerId: deal.ownerId,
        eventType: e.type,
      });
    }
    return rows;
  }
  if (sql.includes("AS cnt")) return [{ cnt: BigInt(0), val: 0 }];
  return [];
}

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    stage: { findMany: async () => h.stages },
    deal: {
      groupBy: async () => [],
      aggregate: async (args: { where: Cond }) => {
        h.aggregateWheres.push(args.where);
        const hit = h.deals.filter((d) => matches(d, args.where));
        return {
          _count: { _all: hit.length },
          _sum: { value: hit.length ? hit.reduce((s, d) => s + d.value, 0) : null },
        };
      },
    },
    user: { findMany: async () => [] },
    $queryRaw: async (q: { sql: string }) => answerRaw(q.sql),
  }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/services/painel-snapshots", () => ({ ensureTodayDealStageSnapshot: vi.fn() }));
vi.mock("@/services/dashboard", () => ({ SOURCE_NONE: "__none__" }));
vi.mock("@/services/kanban-filters", () => ({
  buildDealWhereFromFilters: async (adv: { ownerIds?: string[] }) =>
    adv.ownerIds?.length ? [{ ownerId: { in: adv.ownerIds } }] : [],
}));

import { getPainelFunnel, type PainelDealFilters } from "@/services/painel-deals";

const stage = (id: string, extra: Partial<Stage> = {}, pipelineId = "p1"): Stage => ({
  id,
  name: id,
  color: "#000",
  isWon: false,
  isLost: false,
  pipelineId,
  position: 0,
  ...extra,
});

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

function filters(extra: Partial<PainelDealFilters> = {}): PainelDealFilters {
  return { range: { from: h.from, to: h.to }, pipelineIds: ["p1"], stalledDays: 7, ...extra };
}

beforeEach(() => {
  h.from = day(1);
  h.to = day(7);
  h.aggregateWheres = [];
  h.sqls = [];
  h.stages = [
    stage("novo"),
    stage("proposta"),
    stage("ganho", { isWon: true }),
    stage("perdido", { isLost: true }),
  ];
  h.deals = [
    { id: "d1", stageId: "perdido", status: "OPEN", ownerId: "ana", value: 100 },
    { id: "d2", stageId: "perdido", status: "LOST", ownerId: "ana", value: 50.5 },
    { id: "d3", stageId: "perdido", status: "OPEN", ownerId: "bia", value: 10 },
    { id: "d4", stageId: "novo", status: "OPEN", ownerId: "ana", value: 999 },
    { id: "d5", stageId: "perdido", status: "LOST", ownerId: "bia", value: 0 },
    { id: "d6", stageId: "proposta", status: "OPEN", ownerId: "ana", value: 7 },
  ];
  h.events = [
    // d2: duas idas a Perdido no período → conta 1.
    { dealId: "d2", stageId: "perdido", type: "STAGE_CHANGED", at: day(2) },
    { dealId: "d2", stageId: "novo", type: "STAGE_CHANGED", at: day(3) },
    { dealId: "d2", stageId: "perdido", type: "STAGE_CHANGED", at: day(4) },
    // d3: movido a Perdido antes do período → fora.
    { dealId: "d3", stageId: "perdido", type: "STAGE_CHANGED", at: day(0) },
    // d5: criado direto em Perdido no período → não é envio.
    { dealId: "d5", stageId: "perdido", type: "CREATED", at: day(2) },
    // d6: moveu para uma etapa aberta → não é envio.
    { dealId: "d6", stageId: "proposta", type: "STAGE_CHANGED", at: day(5) },
    // d1: movido a Perdido no período.
    { dealId: "d1", stageId: "perdido", type: "STAGE_CHANGED", at: day(6) },
  ];
});

describe("getPainelFunnel — lostStage", () => {
  it("conta o estoque da etapa Perdido em qualquer status e os envios do período", async () => {
    const out = await getPainelFunnel(filters());
    expect(out.lostStage).toEqual({ count: 4, value: 160.5, sentInPeriod: 2 });
    // As etapas do funil continuam só as abertas.
    expect(out.stages.map((s) => s.id)).toEqual(["novo", "proposta"]);
    // Sem filtro de status no estoque de Perdido; restrito às etapas isLost.
    const where = JSON.stringify(h.aggregateWheres[0]);
    expect(where).not.toContain("status");
    expect(where).toContain('"stageId":{"in":["perdido"]}');
    // O período e o tipo do evento estão no SQL das entradas.
    const enteredSql = h.sqls.find((s) => s.includes("DISTINCT ON"))!;
    expect(enteredSql).toContain("e.type = 'STAGE_CHANGED'");
    expect(enteredSql).toContain('e."createdAt" >= ?');
    expect(enteredSql).toContain('e."createdAt" <= ?');
  });

  it("aplica os filtros estruturais (responsável) ao estoque de Perdido", async () => {
    const out = await getPainelFunnel(filters({ ownerIds: ["ana"] }));
    expect(out.lostStage.count).toBe(2);
    expect(out.lostStage.value).toBe(150.5);
    expect(JSON.stringify(h.aggregateWheres[0])).toContain('"ownerId":{"in":["ana"]}');
    // As entradas recebem o mesmo filtro de responsável no SQL.
    const enteredSql = h.sqls.find((s) => s.includes("DISTINCT ON"))!;
    expect(enteredSql).toContain('d."ownerId" IN');
  });

  it("soma as etapas Perdido de vários funis", async () => {
    h.stages.push(stage("perdido2", { isLost: true }, "p2"));
    h.deals.push({ id: "d7", stageId: "perdido2", status: "OPEN", ownerId: null, value: 1 });
    h.events.push({ dealId: "d7", stageId: "perdido2", type: "STAGE_CHANGED", at: day(3) });
    const out = await getPainelFunnel(filters({ pipelineIds: ["p1", "p2"] }));
    expect(out.lostStage).toEqual({ count: 5, value: 161.5, sentInPeriod: 3 });
  });

  it("funil sem etapa Perdido devolve zeros sem consultar o estoque", async () => {
    h.stages = h.stages.filter((s) => !s.isLost);
    const out = await getPainelFunnel(filters());
    expect(out.lostStage).toEqual({ count: 0, value: 0, sentInPeriod: 0 });
    expect(h.aggregateWheres).toHaveLength(0);
  });

  it("funil sem etapas devolve zeros no retorno vazio", async () => {
    h.stages = [];
    const out = await getPainelFunnel(filters());
    expect(out.empty).toBe(true);
    expect(out.lostStage).toEqual({ count: 0, value: 0, sentInPeriod: 0 });
  });
});
