/**
 * `funnel.stages[].exited / inflow / outflow` em `getPainelFunnel`.
 *
 * Sem banco: o Prisma é simulado. O `$queryRaw` das entradas e o das saídas
 * respondem como o SQL faria (período, 1ª entrada/saída por negócio+etapa e os
 * filtros de funil, responsável e etapa); o texto do SQL é conferido à parte para
 * garantir que os filtros estão nas duas consultas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Deal = { id: string; ownerId: string | null; value: number };
type Ev = {
  dealId: string;
  type: "STAGE_CHANGED" | "CREATED";
  from?: string;
  to: string;
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
type Filters = { pipelineIds: string[]; ownerIds?: string[]; stageIds?: string[] };

const h = vi.hoisted(() => ({
  stages: [] as Stage[],
  deals: [] as Deal[],
  events: [] as Ev[],
  from: new Date(),
  to: new Date(),
  f: { pipelineIds: [] } as Filters,
  sqls: [] as string[],
  calls: 0,
}));

function inPeriod(e: Ev): boolean {
  return e.at >= h.from && e.at <= h.to;
}

/** Filtros que o SQL aplica à etapa de referência (destino na entrada, origem na saída). */
function passes(dealId: string, stageId: string): boolean {
  const stage = h.stages.find((s) => s.id === stageId);
  if (!stage) return false;
  if (h.f.pipelineIds.length && !h.f.pipelineIds.includes(stage.pipelineId)) return false;
  const deal = h.deals.find((d) => d.id === dealId)!;
  if (h.f.ownerIds?.length && !h.f.ownerIds.includes(deal.ownerId ?? "")) return false;
  if (h.f.stageIds?.length && !h.f.stageIds.includes(stageId)) return false;
  return true;
}

const byTime = () => [...h.events].sort((a, b) => a.at.getTime() - b.at.getTime());

function answerRaw(sql: string): unknown[] {
  h.sqls.push(sql);
  if (sql.includes('x."exitedAt"')) {
    const seen = new Set<string>();
    const rows: unknown[] = [];
    for (const e of byTime()) {
      if (e.type !== "STAGE_CHANGED" || !e.from || !inPeriod(e)) continue;
      if (!passes(e.dealId, e.from)) continue;
      const key = `${e.dealId}|${e.from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const to = h.stages.find((s) => s.id === e.to);
      rows.push({
        dealId: e.dealId,
        fromStageId: e.from,
        toStageId: e.to,
        toStageName: to?.name ?? null,
        toPipelineId: to?.pipelineId ?? null,
      });
    }
    return rows;
  }
  if (sql.includes("DISTINCT ON")) {
    const seen = new Set<string>();
    const rows: unknown[] = [];
    for (const e of byTime()) {
      if (!inPeriod(e) || !passes(e.dealId, e.to)) continue;
      const key = `${e.dealId}|${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const deal = h.deals.find((d) => d.id === e.dealId)!;
      const from = e.from ? h.stages.find((s) => s.id === e.from) : undefined;
      rows.push({
        dealId: e.dealId,
        stageId: e.to,
        enteredAt: e.at,
        value: deal.value,
        ownerId: deal.ownerId,
        eventType: e.type,
        fromStageId: e.type === "CREATED" ? null : (e.from ?? null),
        fromStageName: from?.name ?? null,
        fromPipelineId: from?.pipelineId ?? null,
      });
    }
    return rows;
  }
  if (sql.includes("AS cnt")) return [{ cnt: BigInt(0), val: 0 }];
  return [];
}

function counted<T extends unknown[], R>(fn: (...a: T) => R) {
  return (...a: T): R => {
    h.calls += 1;
    return fn(...a);
  };
}

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    stage: {
      findMany: counted(async (args: { where: { pipelineId?: { in: string[] } } }) => {
        const ids = args.where.pipelineId?.in;
        return ids ? h.stages.filter((s) => ids.includes(s.pipelineId)) : h.stages;
      }),
    },
    deal: {
      groupBy: counted(async () => []),
      aggregate: counted(async () => ({ _count: { _all: 0 }, _sum: { value: null } })),
    },
    user: { findMany: counted(async () => []) },
    $queryRaw: counted(async (q: { sql: string }) => answerRaw(q.sql)),
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
  buildDealWhereFromFilters: async () => [],
}));

import {
  FUNNEL_FLOW_TOP,
  getPainelFunnel,
  type PainelDealFilters,
  type PainelFunnelStage,
} from "@/services/painel-deals";

const stage = (id: string, pipelineId = "p1", extra: Partial<Stage> = {}): Stage => ({
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

async function run(extra: Partial<PainelDealFilters> = {}) {
  const f: PainelDealFilters = {
    range: { from: h.from, to: h.to },
    pipelineIds: ["p1"],
    stalledDays: 7,
    ...extra,
  };
  h.f = { pipelineIds: f.pipelineIds, ownerIds: f.ownerIds, stageIds: f.stageIds };
  const out = await getPainelFunnel(f);
  return { out, at: (id: string) => out.stages.find((s) => s.id === id)! };
}

function sums(s: PainelFunnelStage) {
  return {
    inflow: s.inflow.reduce((n, r) => n + r.count, 0),
    outflow: s.outflow.reduce((n, r) => n + r.count, 0),
  };
}

const ev = (dealId: string, from: string | undefined, to: string, d: number): Ev =>
  from
    ? { dealId, type: "STAGE_CHANGED", from, to, at: day(d) }
    : { dealId, type: "CREATED", to, at: day(d) };

beforeEach(() => {
  h.from = day(1);
  h.to = day(7);
  h.sqls = [];
  h.calls = 0;
  h.stages = [
    stage("A"),
    stage("B"),
    stage("C"),
    stage("ganho", "p1", { isWon: true }),
    stage("perdido", "p1", { isLost: true }),
    stage("X", "p2"),
  ];
  h.deals = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"].map((id) => ({
    id,
    ownerId: id === "d2" ? "bia" : "ana",
    value: 10,
  }));
  h.events = [
    ev("d1", undefined, "A", 2), // criado em A
    ev("d1", "A", "B", 3),
    ev("d1", "B", "C", 4),
    ev("d2", undefined, "A", 2), // criado em A
    ev("d2", "A", "perdido", 3),
    ev("d3", "X", "A", 3), // de outro funil → A
    ev("d4", "A", "B", 5), // criado antes do período
    ev("d5", "C", "X", 6), // C → outro funil
    ev("d7", "A", "B", 0), // fora do período
  ];
});

describe("getPainelFunnel — entradas e saídas por etapa", () => {
  it("monta entered/exited/inflow/outflow com somas batendo", async () => {
    const { out, at } = await run();
    expect(out.stages.map((s) => s.id)).toEqual(["A", "B", "C"]);

    expect(at("A").entered).toBe(3);
    expect(at("A").inflow).toEqual([
      { fromStageId: null, count: 2 },
      { fromStageId: "X", fromStageName: "X", fromPipelineId: "p2", count: 1 },
    ]);
    expect(at("A").exited).toBe(3);
    expect(at("A").outflow).toEqual([
      { toStageId: "B", toStageName: "B", count: 2 },
      { toStageId: "perdido", toStageName: "perdido", count: 1 },
    ]);

    expect(at("B").entered).toBe(2);
    expect(at("B").inflow).toEqual([{ fromStageId: "A", fromStageName: "A", count: 2 }]);
    expect(at("B").exited).toBe(1);
    expect(at("B").outflow).toEqual([{ toStageId: "C", toStageName: "C", count: 1 }]);

    expect(at("C").entered).toBe(1);
    expect(at("C").inflow).toEqual([{ fromStageId: "B", fromStageName: "B", count: 1 }]);
    expect(at("C").exited).toBe(1);
    expect(at("C").outflow).toEqual([
      { toStageId: "X", toStageName: "X", toPipelineId: "p2", count: 1 },
    ]);

    for (const s of out.stages) {
      expect(sums(s)).toEqual({ inflow: s.entered, outflow: s.exited });
    }
  });

  it("negócio que volta à etapa conta só a 1ª entrada e a 1ª saída", async () => {
    h.events = [
      ev("d6", "C", "B", 2),
      ev("d6", "B", "A", 3),
      ev("d6", "A", "B", 4), // 2ª entrada em B, vinda de outra origem
      ev("d6", "B", "C", 5), // 2ª saída de B, para outro destino
    ];
    const { out, at } = await run();
    expect(at("B").entered).toBe(1);
    expect(at("B").inflow).toEqual([{ fromStageId: "C", fromStageName: "C", count: 1 }]);
    expect(at("B").exited).toBe(1);
    expect(at("B").outflow).toEqual([{ toStageId: "A", toStageName: "A", count: 1 }]);
    for (const s of out.stages) {
      expect(sums(s)).toEqual({ inflow: s.entered, outflow: s.exited });
    }
  });

  it("ordena por count desc e agrega o que passa do teto em \"other\"", async () => {
    h.events = [];
    h.deals = [];
    // 10 origens distintas (outro funil) → A; S0 com 3 negócios, as demais com 1.
    for (let i = 0; i < 10; i++) {
      h.stages.push(stage(`S${i}`, "p2"));
      const n = i === 0 ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const id = `s${i}_${k}`;
        h.deals.push({ id, ownerId: "ana", value: 1 });
        h.events.push(ev(id, `S${i}`, "A", 3));
        h.events.push(ev(id, "A", `S${i}`, 4));
      }
    }
    const { at } = await run();
    const a = at("A");
    expect(a.entered).toBe(12);
    expect(a.inflow).toHaveLength(FUNNEL_FLOW_TOP + 1);
    expect(a.inflow[0]).toMatchObject({ fromStageId: "S0", count: 3 });
    expect(a.inflow.slice(1, FUNNEL_FLOW_TOP).map((r) => r.fromStageId)).toEqual([
      "S1", "S2", "S3", "S4", "S5", "S6", "S7",
    ]);
    expect(a.inflow[FUNNEL_FLOW_TOP]).toEqual({ fromStageId: "other", count: 2 });
    expect(a.exited).toBe(12);
    expect(a.outflow[0]).toMatchObject({ toStageId: "S0", count: 3, toPipelineId: "p2" });
    expect(a.outflow[FUNNEL_FLOW_TOP]).toEqual({ toStageId: "other", count: 2 });
    expect(sums(a)).toEqual({ inflow: 12, outflow: 12 });
    for (let i = 1; i < a.inflow.length - 1; i++) {
      expect(a.inflow[i - 1]!.count).toBeGreaterThanOrEqual(a.inflow[i]!.count);
    }
  });

  it("respeita os filtros de responsável e de etapa nas duas consultas", async () => {
    const { at } = await run({ ownerIds: ["ana"] });
    // d2 (bia) some: A perde a entrada criada e a saída para Perdido.
    expect(at("A").entered).toBe(2);
    expect(at("A").inflow).toEqual([
      { fromStageId: null, count: 1 },
      { fromStageId: "X", fromStageName: "X", fromPipelineId: "p2", count: 1 },
    ]);
    expect(at("A").outflow).toEqual([{ toStageId: "B", toStageName: "B", count: 2 }]);
    const enteredSql = h.sqls.find((s) => s.includes("DISTINCT ON") && !s.includes("exitedAt"))!;
    const exitSql = h.sqls.find((s) => s.includes('x."exitedAt"'))!;
    for (const sql of [enteredSql, exitSql]) {
      expect(sql).toContain('d."ownerId" IN');
      expect(sql).toContain("e.type = 'STAGE_CHANGED'");
      expect(sql).toContain('e."createdAt" >= ?');
      expect(sql).toContain('e."createdAt" <= ?');
      expect(sql).toContain('s."pipelineId" IN');
    }

    h.sqls = [];
    const r2 = await run({ stageIds: ["B"], tagIds: ["t1"], sources: ["ig"] });
    expect(r2.at("B").exited).toBe(1);
    expect(r2.at("A").exited).toBe(0);
    expect(r2.at("A").outflow).toEqual([]);
    const enteredSql2 = h.sqls.find((s) => s.includes("DISTINCT ON") && !s.includes("exitedAt"))!;
    const exitSql2 = h.sqls.find((s) => s.includes('x."exitedAt"'))!;
    expect(enteredSql2).toContain('x."stageId" IN');
    expect(exitSql2).toContain('x."fromStageId" IN');
    for (const sql of [enteredSql2, exitSql2]) {
      expect(sql).toContain("tags_on_deals");
      expect(sql).toContain("c.source IN");
    }
  });

  it("junta origens/destinos ao somar etapas de mesmo nome entre funis", async () => {
    h.stages.push(stage("A2", "p2", { name: "A" }));
    h.events.push(ev("d6", "X", "A2", 3));
    const { out } = await run({ pipelineIds: ["p1", "p2"] });
    const a = out.stages.find((s) => s.name === "A")!;
    // A (p1): criados 2 + de X 1; A (p2): de X 1. X é do funil de A2 → sem pipelineId.
    expect(a.entered).toBe(4);
    // Empate em count: desempate pelo id (criados, `null`, primeiro).
    expect(a.inflow).toEqual([
      { fromStageId: null, count: 2 },
      { fromStageId: "X", fromStageName: "X", fromPipelineId: "p2", count: 2 },
    ]);
    expect(sums(a).inflow).toBe(a.entered);
  });

  it("a seção funnel faz uma consulta a mais (saídas), sem N+1", async () => {
    await run();
    // Antes: stage.findMany, deal.groupBy, deal.aggregate (Perdido), user.findMany
    // e 3 $queryRaw (entradas, entradas posteriores, novos) = 7. Agora + a das
    // saídas = 8.
    expect(h.calls).toBe(8);
    expect(h.sqls).toHaveLength(4);
    // Mais negócios/etapas não mudam o número de consultas.
    h.calls = 0;
    h.sqls = [];
    for (let i = 0; i < 20; i++) {
      h.deals.push({ id: `n${i}`, ownerId: "ana", value: 1 });
      h.events.push(ev(`n${i}`, "A", "B", 3), ev(`n${i}`, "B", "C", 4));
    }
    await run();
    expect(h.calls).toBe(8);
  });
});
