/**
 * Benchmark SINTÉTICO da busca do Kanban ("ana" no board, perStage 50), com
 * banco em memória: 10 mil contatos com "ana" no nome, 12 mil negócios abertos
 * em 8 etapas. NÃO mede o Postgres (não há banco aqui): mede o que o Node faz
 * e manda para ele — número de consultas, parâmetros enviados, ids que viajam
 * Postgres → Node → Postgres e o custo de CPU do lado do Node.
 *
 * O mesmo arquivo roda no código antigo (DEV_BRANCH) e no novo: o banco falso
 * reconhece as pré-consultas antigas (`SELECT id FROM contacts WHERE … ILIKE`,
 * teto 5000 cada) e as consultas novas (busca dentro da janela). Imprime uma
 * linha por cenário; só afirma que o board volta completo.
 *
 *   npx vitest run src/services/__tests__/deal-search-bench.test.ts
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn(),
    stageFindMany: vi.fn(),
    dealFindMany: vi.fn(),
    dealGroupBy: vi.fn(),
    dealCount: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    stage: { findMany: h.stageFindMany },
    deal: { findMany: h.dealFindMany, groupBy: h.dealGroupBy, count: h.dealCount },
  },
  allocateOrgNumber: vi.fn(),
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn(),
  userIdForFk: vi.fn(),
  withAutomationOriginMeta: vi.fn((m: unknown) => m),
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: vi.fn(async () => true),
  getOrgSettingFor: vi.fn(async () => null),
  getOrgSetting: vi.fn(async () => null),
}));
vi.mock("@/services/analytics", () => ({ getStageMetrics: vi.fn(async () => []) }));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async () => undefined),
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));

import { Prisma } from "@prisma/client";

import { runWithContext } from "@/lib/request-context";
import { ServerTiming } from "@/lib/server-timing";
import { getBoardJson, getDeals } from "@/services/deals";

const ORG = "org-bench";
const PIPELINE = "pipe-1";
const STAGES = 8;
const CONTACTS = 10_000;
const DEALS = 12_000;
const CAP = 5000; // SEARCH_CANDIDATE_CAP do código antigo

const stages = Array.from({ length: STAGES }, (_, i) => ({
  id: `s${i + 1}`,
  organizationId: ORG,
  pipelineId: PIPELINE,
  name: `Etapa ${i + 1}`,
  slug: `etapa-${i + 1}`,
  number: i + 1,
  position: i + 1,
  color: "#000",
  winProbability: 0,
  rottingDays: 30,
  isIncoming: false,
  isWon: false,
  isLost: false,
  requiredDealFieldIds: [] as string[],
}));
const deals = Array.from({ length: DEALS }, (_, i) => ({
  id: `d${i}`,
  title: `Negócio ${i}`,
  status: "OPEN",
  stageId: `s${(i % STAGES) + 1}`,
  contactId: `c${Math.floor(i / STAGES) % CONTACTS}`,
  position: i,
  updatedAt: new Date(Date.UTC(2026, 9, 1) + i * 1000),
  organizationId: ORG,
}));
const dealById = new Map(deals.map((d) => [d.id, d]));

type Stats = {
  queryRaw: number;
  findMany: number;
  /** Ids devolvidos pelas pré-consultas ao Node. */
  idsToNode: number;
  /** Parâmetros enviados ao Postgres (um por id em `IN`; um array = 1 em `ANY($1)`). */
  bindParams: number;
  /** Maior consulta, em parâmetros. */
  maxParams: number;
};

function walkInArrays(v: unknown, visit: (arr: unknown[]) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walkInArrays(x, visit));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "in" && Array.isArray(x)) visit(x);
      else walkInArrays(x, visit);
    }
  }
}

function install(stats: Stats) {
  h.stageFindMany.mockImplementation(async () => stages);
  h.queryRaw.mockImplementation(async (...call: unknown[]) => {
    stats.queryRaw++;
    const first = call[0] as TemplateStringsArray | Prisma.Sql;
    const sql = Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...call.slice(1))
      : (first as Prisma.Sql);
    const text = sql.strings.join("?");
    // Cada valor escalar é um parâmetro; um array passado a `ANY(?)` é um só.
    stats.bindParams += sql.values.length;
    stats.maxParams = Math.max(stats.maxParams, sql.values.length);

    // --- código antigo: pré-consultas de candidatos (teto 5000 cada) ---
    if (/SELECT id FROM contacts\s+WHERE "organizationId" = \? AND name ILIKE/.test(text)) {
      const rows = Array.from({ length: Math.min(CAP, CONTACTS) }, (_, i) => ({ id: `c${i}` }));
      stats.idsToNode += rows.length;
      return rows;
    }
    if (/SELECT id FROM contacts\s+WHERE "organizationId" = \? AND email ILIKE/.test(text)) {
      const rows = Array.from({ length: 3040 }, (_, i) => ({ id: `c${i}` }));
      stats.idsToNode += rows.length;
      return rows;
    }
    if (/FROM deal_custom_field_values/.test(text) && /LIMIT/.test(text)) {
      const rows = Array.from({ length: CAP }, (_, i) => ({ dealId: `d${i}` }));
      stats.idsToNode += rows.length;
      return rows;
    }
    if (/SELECT id FROM contacts|FROM contact_custom_field_values/.test(text)) return [];

    // --- janela ranqueada (antigo: `d.id = ANY(ids)`; novo: busca dentro) ---
    if (text.includes('PARTITION BY d."stageId"')) {
      const idArray = sql.values.find((v): v is string[] => Array.isArray(v) && v.length > STAGES);
      const allowed = idArray ? new Set(idArray) : null;
      const maxPerStage = Number(sql.values.at(-1));
      const byStage = new Map<string, typeof deals>();
      for (const d of deals) {
        const hit = allowed
          ? allowed.has(d.id)
          : Math.floor(Number(d.id.slice(1)) / STAGES) % 2 === 0; // metade é "Ana …"
        if (!hit) continue;
        byStage.set(d.stageId, [...(byStage.get(d.stageId) ?? []), d]);
      }
      const rows: { id: string; stageId: string; rn: number; total: number }[] = [];
      for (const [stageId, list] of byStage) {
        list.sort((a, b) => a.position - b.position);
        list
          .slice(0, maxPerStage)
          .forEach((d, i) => rows.push({ id: d.id, stageId, rn: i + 1, total: list.length }));
      }
      return rows;
    }
    // --- ids da busca (lista) ---
    if (text.includes("SELECT d.id FROM deals d")) {
      const limit = Number(sql.values.at(-1));
      const rows = deals
        .filter((d) => Math.floor(Number(d.id.slice(1)) / STAGES) % 2 === 0)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit)
        .map((d) => ({ id: d.id }));
      stats.idsToNode += rows.length;
      return rows;
    }
    return [];
  });

  h.dealFindMany.mockImplementation(
    async (args: { where?: unknown; select?: unknown; skip?: number; take?: number }) => {
      stats.findMany++;
      let params = 0;
      let inIds: string[] | null = null;
      const contactIds = new Set<string>();
      walkInArrays(args.where, (arr) => {
        params += arr.length;
        const w = JSON.stringify(args.where);
        if (w.includes('"contactId":{"in"')) for (const x of arr) contactIds.add(String(x));
        else if (!inIds || arr.length > inIds.length) inIds = arr as string[];
      });
      stats.bindParams += params;
      stats.maxParams = Math.max(stats.maxParams, params);
      // Pré-resolução antiga: `contactId IN (…)`; hidratação/lista nova: `id IN (…)`.
      const pool =
        contactIds.size > 0
          ? deals.filter((d) => contactIds.has(d.contactId))
          : (inIds ?? []).map((id) => dealById.get(id)).filter((d) => d !== undefined);
      const skip = args.skip ?? 0;
      const rows = pool.slice(skip, skip + (args.take ?? pool.length));
      if (args.select) return rows.map((d) => ({ id: d.id, stageId: d.stageId }));
      return rows.map((d) => ({
        ...d,
        ownerId: null,
        value: 0,
        createdAt: d.updatedAt,
        contact: { id: d.contactId, name: "x", lastMessageAt: null, tags: [] },
        owner: null,
        tags: [],
        stage: stages.find((s) => s.id === d.stageId),
        activities: [],
        _count: { activities: 0 },
      }));
    },
  );
  h.dealGroupBy.mockImplementation(async () => []);
  h.dealCount.mockImplementation(async () => 0);
}

const withOrg = <T>(fn: () => Promise<T>) =>
  runWithContext(
    { organizationId: ORG, userId: "u1", isSuperAdmin: false, actor: "USER" } as never,
    fn,
  );

const fresh = (): Stats => ({ queryRaw: 0, findMany: 0, idsToNode: 0, bindParams: 0, maxParams: 0 });

function report(label: string, stats: Stats, timing: ServerTiming, ms: number) {
  const t = timing.toJSON();
  const phases = ["filters", "search.pre", "search.apply", "search.ids", "cards"]
    .filter((k) => t[k] !== undefined)
    .map((k) => `${k}=${t[k]}`)
    .join(" ");
  // eslint-disable-next-line no-console -- saída do benchmark
  console.log(
    `[bench] ${label}: consultas=${stats.queryRaw}+${stats.findMany}findMany ` +
      `ids_ao_node=${stats.idsToNode} parametros_enviados=${stats.bindParams} ` +
      `maior_consulta=${stats.maxParams} cpu_node=${ms.toFixed(0)}ms ${phases}`,
  );
}

describe("benchmark sintético: busca 'ana' (10 mil contatos 'ana', 12 mil negócios)", () => {
  it("board: POST /pipelines/:id/board { filters: { search: 'ana' }, perStage: 50 }", async () => {
    const stats = fresh();
    h.queryRaw.mockReset();
    install(stats);
    const timing = new ServerTiming();
    const t0 = performance.now();
    const { json } = await withOrg(() =>
      getBoardJson(PIPELINE, null, "OPEN", { search: "ana" }, { perStage: 50 }, { timing }),
    );
    report("board", stats, timing, performance.now() - t0);
    const board = JSON.parse(json) as { deals: unknown[] }[];
    expect(board).toHaveLength(STAGES);
    expect(board.every((s) => s.deals.length === 50)).toBe(true);
  });

  it("busca rápida: GET /deals?search=ana&page=1&perPage=8&withTotal=0", async () => {
    const stats = fresh();
    h.queryRaw.mockReset();
    h.dealFindMany.mockReset();
    install(stats);
    const t0 = performance.now();
    const res = await withOrg(() => getDeals({ search: "ana", page: 1, perPage: 8, withTotal: false }));
    report("lista", stats, new ServerTiming(), performance.now() - t0);
    expect(res.items).toHaveLength(8);
    expect(h.dealCount).not.toHaveBeenCalled();
  });
});
