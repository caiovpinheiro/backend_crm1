/**
 * `funnel.novos` x `inflow[fromStageId=null]` ("criados aqui") em `getPainelFunnel`.
 *
 * Sem banco: o Prisma é simulado. O `$queryRaw` das entradas responde como o SQL
 * faria, inclusive o ramo dos negócios criados no período sem evento CREATED
 * utilizável (etapa de criação = origem do 1º STAGE_CHANGED; sem movimento, a
 * etapa atual).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Deal = {
  id: string;
  stageId: string;
  createdAt: Date;
  ownerId: string | null;
  value: number;
};
type Ev = {
  dealId: string;
  type: "STAGE_CHANGED" | "CREATED";
  from?: string;
  /** Destino do STAGE_CHANGED ou `meta.stageId` do CREATED (pode faltar). */
  to?: string;
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
  f: { pipelineIds: [] as string[], ownerIds: undefined as string[] | undefined },
  sqls: [] as string[],
}));

const inPeriod = (d: Date) => d >= h.from && d <= h.to;

function passes(dealId: string, stageId: string): boolean {
  const stage = h.stages.find((s) => s.id === stageId);
  if (!stage) return false;
  if (h.f.pipelineIds.length && !h.f.pipelineIds.includes(stage.pipelineId)) return false;
  const deal = h.deals.find((d) => d.id === dealId)!;
  if (h.f.ownerIds?.length && !h.f.ownerIds.includes(deal.ownerId ?? "")) return false;
  return true;
}

type Row = {
  dealId: string;
  stageId: string;
  enteredAt: Date;
  eventType: string;
  fromStageId: string | null;
};

/** As três origens de linha da consulta de entradas. */
function enteredRows(): Row[] {
  const rows: Row[] = [];
  for (const e of h.events) {
    if (!inPeriod(e.at) || !e.to) continue;
    rows.push({
      dealId: e.dealId,
      stageId: e.to,
      enteredAt: e.at,
      eventType: e.type,
      fromStageId: e.type === "STAGE_CHANGED" ? (e.from ?? null) : null,
    });
  }
  for (const d of h.deals) {
    if (!inPeriod(d.createdAt)) continue;
    const hasCreated = h.events.some(
      (e) => e.dealId === d.id && e.type === "CREATED" && e.to && inPeriod(e.at),
    );
    if (hasCreated) continue;
    const firstMove = h.events
      .filter((e) => e.dealId === d.id && e.type === "STAGE_CHANGED" && e.from && e.at >= d.createdAt)
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    rows.push({
      dealId: d.id,
      stageId: firstMove?.from ?? d.stageId,
      enteredAt: d.createdAt,
      eventType: "CREATED",
      fromStageId: null,
    });
  }
  return rows;
}

function answerRaw(sql: string): unknown[] {
  h.sqls.push(sql);
  if (sql.includes('x."exitedAt"')) return [];
  if (sql.includes("DISTINCT ON")) {
    const sorted = enteredRows().sort(
      (a, b) =>
        a.enteredAt.getTime() - b.enteredAt.getTime() ||
        Number(b.eventType === "CREATED") - Number(a.eventType === "CREATED"),
    );
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const r of sorted) {
      if (!passes(r.dealId, r.stageId)) continue;
      const key = `${r.dealId}|${r.stageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const deal = h.deals.find((d) => d.id === r.dealId)!;
      const from = r.fromStageId ? h.stages.find((s) => s.id === r.fromStageId) : undefined;
      out.push({
        ...r,
        value: deal.value,
        ownerId: deal.ownerId,
        fromStageName: from?.name ?? null,
        fromPipelineId: from?.pipelineId ?? null,
      });
    }
    return out;
  }
  return [];
}

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    stage: {
      findMany: async (args: { where: { pipelineId?: { in: string[] } } }) => {
        const ids = args.where.pipelineId?.in;
        return ids ? h.stages.filter((s) => ids.includes(s.pipelineId)) : h.stages;
      },
    },
    deal: {
      groupBy: async () => [],
      aggregate: async () => ({ _count: { _all: 0 }, _sum: { value: null } }),
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
  buildDealWhereFromFilters: async () => [],
}));

import {
  getPainelFunnel,
  type PainelDealFilters,
  type PainelFunnel,
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
  h.f = { pipelineIds: f.pipelineIds, ownerIds: f.ownerIds };
  return getPainelFunnel(f);
}

const createdHere = (out: PainelFunnel, id: string) =>
  out.stages.find((s) => s.id === id)!.inflow.find((r) => r.fromStageId === null)?.count ?? 0;

const createdHereTotal = (out: PainelFunnel) =>
  out.stages.reduce((n, s) => n + (s.inflow.find((r) => r.fromStageId === null)?.count ?? 0), 0);

const deal = (id: string, stageId: string, created: number, ownerId = "ana"): Deal => ({
  id,
  stageId,
  createdAt: day(created),
  ownerId,
  value: 10,
});

beforeEach(() => {
  h.from = day(1);
  h.to = day(7);
  h.sqls = [];
  h.stages = [
    stage("A"),
    stage("B"),
    stage("ganho", "p1", { isWon: true }),
    stage("perdido", "p1", { isLost: true }),
    stage("X", "p2"),
  ];
  h.deals = [
    deal("semEvento", "A", 2), // inbound/importação: sem CREATED, parado em A
    deal("semStageId", "B", 2), // CREATED sem meta.stageId, hoje em B
    deal("criadoMovido", "B", 2), // sem CREATED, criado em A e movido para B
    deal("emPerdido", "perdido", 2), // sem CREATED, criado direto em Perdido
    deal("comEvento", "A", 2), // fluxo normal: CREATED com stageId
    deal("daBia", "A", 2, "bia"), // sem CREATED, outro responsável
    deal("antigo", "B", 0), // criado antes do período
    deal("outroFunil", "A", 2), // criado no funil p2 e movido para A
  ];
  h.events = [
    { dealId: "semStageId", type: "CREATED", at: day(2) },
    { dealId: "criadoMovido", type: "STAGE_CHANGED", from: "A", to: "B", at: day(3) },
    { dealId: "comEvento", type: "CREATED", to: "A", at: day(2) },
    { dealId: "antigo", type: "STAGE_CHANGED", from: "A", to: "B", at: day(3) },
    { dealId: "outroFunil", type: "STAGE_CHANGED", from: "X", to: "A", at: day(3) },
  ];
});

describe("getPainelFunnel — novos batem com os criados nas etapas", () => {
  it("conta criados sem CREATED, com CREATED sem stageId, criado e movido e criado em Perdido", async () => {
    const out = await run();
    // A: semEvento, criadoMovido (origem do 1º movimento), comEvento, daBia.
    expect(createdHere(out, "A")).toBe(4);
    // B: semStageId (etapa atual, sem movimento).
    expect(createdHere(out, "B")).toBe(1);
    // criadoMovido entrou em B vindo de A; antigo também (criado antes do período).
    expect(out.stages.find((s) => s.id === "B")!.inflow).toEqual([
      { fromStageId: "A", fromStageName: "A", count: 2 },
      { fromStageId: null, count: 1 },
    ]);
    // outroFunil nasceu em X (p2): não é novo deste funil, é entrada vinda de lá.
    expect(out.stages.find((s) => s.id === "A")!.inflow).toContainEqual({
      fromStageId: "X",
      fromStageName: "X",
      fromPipelineId: "p2",
      count: 1,
    });
    expect(out.novosForaDoFunil).toEqual({ count: 1, won: 0, lost: 1 });
    expect(out.novos).toEqual({ count: 6, value: 60 });
    expect(createdHereTotal(out) + out.novosForaDoFunil.count).toBe(out.novos.count);
    // Perdido por criação não é "envio" para Perdido.
    expect(out.lostStage.sentInPeriod).toBe(0);
    for (const s of out.stages) {
      expect(s.inflow.reduce((n, r) => n + r.count, 0)).toBe(s.entered);
    }
  });

  it("aplica os mesmos filtros aos novos e às entradas", async () => {
    const out = await run({ ownerIds: ["ana"] });
    expect(createdHere(out, "A")).toBe(3);
    expect(out.novos.count).toBe(5);
    expect(createdHereTotal(out) + out.novosForaDoFunil.count).toBe(out.novos.count);
    const enteredSql = h.sqls.find((s) => s.includes("DISTINCT ON") && !s.includes("exitedAt"))!;
    // O ramo dos criados sem evento passa pelos mesmos filtros (WHERE externo).
    expect(enteredSql).toContain("FROM deals d0");
    expect(enteredSql).toContain('d0."createdAt" >= ?');
    expect(enteredSql).toContain("NOT EXISTS");
    expect(enteredSql).toContain('d."ownerId" IN');
    // Sem consulta separada para os novos.
    expect(h.sqls.some((s) => s.includes("AS cnt"))).toBe(false);
  });

  it("toda leitura de deal_events por período usa org + tipo + createdAt (índice deal_events_org_type_created_idx)", async () => {
    await run();
    const enteredSql = h.sqls.find((s) => s.includes("DISTINCT ON") && !s.includes("exitedAt"))!;
    const exitSql = h.sqls.find((s) => s.includes('x."exitedAt"'))!;
    const laterSql = h.sqls.find((s) => !s.includes("DISTINCT ON"))!;
    // Recorta cada `FROM deal_events e` (alias `e`: as varreduras por período;
    // `e2`/`e3` são por negócio, no índice (dealId, createdAt)) até o fim do WHERE.
    const scans = (sql: string) =>
      sql
        .split(/FROM deal_events e\s/)
        .slice(1)
        .map((chunk) => chunk.split(/UNION ALL|\) x/)[0]!);
    const all = [...scans(enteredSql), ...scans(exitSql), ...scans(laterSql)];
    // Entradas: STAGE_CHANGED + CREATED; saídas: STAGE_CHANGED; posteriores: os dois.
    expect(all).toHaveLength(5);
    for (const where of all) {
      expect(where).toContain('e."organizationId" = ?');
      expect(where).toMatch(/e\.type = '(STAGE_CHANGED|CREATED)'/);
      expect(where).toContain('e."createdAt" >= ?');
    }
    // Os criados sem evento leem deal_events por negócio, não por período.
    expect(enteredSql).toContain('e2."dealId" = d0.id');
    expect(enteredSql).toContain('e3."dealId" = d0.id');
  });

  it("negócio com CREATED utilizável não é contado de novo pelo ramo dos sem evento", async () => {
    h.deals = [deal("comEvento", "B", 2)];
    h.events = [
      { dealId: "comEvento", type: "CREATED", to: "A", at: day(2) },
      { dealId: "comEvento", type: "STAGE_CHANGED", from: "A", to: "B", at: day(3) },
    ];
    const out = await run();
    expect(out.novos.count).toBe(1);
    expect(createdHere(out, "A")).toBe(1);
    expect(createdHere(out, "B")).toBe(0);
  });
});
