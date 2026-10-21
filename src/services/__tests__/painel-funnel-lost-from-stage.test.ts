/**
 * `stages[].lost` em `getPainelFunnel`: perdas DA ETAPA — negócios que saíram
 * desta etapa direto para uma etapa Perdido no período.
 *
 * Antes era a coorte "dos que entraram no período, quantos chegaram a Perdido
 * depois por qualquer caminho", que não batia com "Saíram → para Perdido" do
 * mesmo card (ex.: 40 perdas com 24 saídas para Perdido).
 *
 * Sem banco: o `$queryRaw` das saídas responde como o SQL faria (1ª saída por
 * negócio+etapa e `wentLost` = alguma saída do negócio desta etapa foi para
 * uma etapa Perdido no período).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Stage = {
  id: string;
  name: string;
  color: string;
  isWon: boolean;
  isLost: boolean;
  pipelineId: string;
  position: number;
};
type Move = { dealId: string; from: string; to: string; at: Date };

const h = vi.hoisted(() => ({
  stages: [] as Stage[],
  moves: [] as Move[],
  from: new Date(),
  to: new Date(),
  sqls: [] as string[],
}));

function exitRows(): unknown[] {
  const inPeriod = h.moves.filter((m) => m.at >= h.from && m.at <= h.to);
  const groups = new Map<string, Move[]>();
  for (const m of inPeriod) {
    const k = `${m.dealId}|${m.from}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = sorted[0]!;
    const to = h.stages.find((s) => s.id === first.to);
    return {
      dealId: first.dealId,
      fromStageId: first.from,
      toStageId: first.to,
      toStageName: to?.name ?? null,
      toPipelineId: to?.pipelineId ?? null,
      wentLost: list.some((m) => h.stages.find((s) => s.id === m.to)?.isLost === true),
    };
  });
}

function answerRaw(sql: string): unknown[] {
  h.sqls.push(sql);
  if (sql.includes('x."exitedAt"')) return exitRows();
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

import { getPainelFunnel } from "@/services/painel-deals";

const stage = (id: string, extra: Partial<Stage> = {}): Stage => ({
  id,
  name: id,
  color: "#000",
  isWon: false,
  isLost: false,
  pipelineId: "p1",
  position: 0,
  ...extra,
});
const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12));
const mv = (dealId: string, from: string, to: string, d: number): Move => ({
  dealId,
  from,
  to,
  at: day(d),
});

async function run() {
  return getPainelFunnel({
    range: { from: h.from, to: h.to },
    pipelineIds: ["p1"],
    stalledDays: 7,
  });
}

beforeEach(() => {
  h.from = day(10);
  h.to = day(20);
  h.sqls = [];
  h.stages = [
    stage("robo"),
    stage("atendimento"),
    stage("perdido", { isLost: true }),
    stage("ganho", { isWon: true }),
  ];
  h.moves = [
    mv("direto", "robo", "perdido", 11), // saiu do Robô direto para Perdido
    mv("depois", "robo", "atendimento", 11), // perdido depois, em outra etapa
    mv("depois", "atendimento", "perdido", 12),
    mv("voltou", "robo", "atendimento", 11), // 1ª saída não é Perdido, volta e perde daqui
    mv("voltou", "atendimento", "robo", 12),
    mv("voltou", "robo", "perdido", 13),
    mv("antigo", "robo", "perdido", 14), // entrou no Robô antes do período
    mv("foraDoPeriodo", "robo", "perdido", 5), // perda antes do período
    mv("ganhou", "atendimento", "ganho", 15),
  ];
});

describe("getPainelFunnel — perdas da etapa", () => {
  it("conta quem saiu desta etapa direto para Perdido no período", async () => {
    const out = await run();
    const robo = out.stages.find((s) => s.id === "robo")!;
    const atendimento = out.stages.find((s) => s.id === "atendimento")!;
    // direto + voltou + antigo; "depois" foi perdido a partir de Em Atendimento.
    expect(robo.lost).toBe(3);
    expect(atendimento.lost).toBe(1);
  });

  it("perdas nunca passam das saídas da etapa", async () => {
    const out = await run();
    for (const s of out.stages) {
      expect(s.lost).toBeLessThanOrEqual(s.exited);
    }
    const robo = out.stages.find((s) => s.id === "robo")!;
    expect(robo.exited).toBe(4);
    // Saídas pela 1ª saída: "voltou" aparece em Em Atendimento, mas conta como perda do Robô.
    expect(robo.outflow.find((r) => r.toStageId === "perdido")?.count).toBe(2);
  });

  it("a consulta de saídas marca a saída para Perdido sem consulta extra", async () => {
    await run();
    const exitSql = h.sqls.find((s) => s.includes('x."exitedAt"'))!;
    expect(exitSql).toContain('ts."isLost"');
    expect(exitSql).toContain('PARTITION BY x."dealId", x."fromStageId"');
    expect(h.sqls.filter((s) => s.includes('x."exitedAt"'))).toHaveLength(1);
  });

  it("sem saídas para Perdido, zero perdas", async () => {
    h.moves = [mv("a", "robo", "atendimento", 11)];
    const out = await run();
    expect(out.stages.every((s) => s.lost === 0)).toBe(true);
  });
});
