/**
 * Busca livre de negócios dentro da consulta (`createDealSearch`).
 *
 * Banco falso em memória: 10 mil contatos com "ana" no nome e 12 mil negócios
 * abertos num funil de 8 etapas. O que é provado:
 *
 *   1) o board com busca vai por UMA janela ranqueada com a busca em
 *      subconsultas: sem pré-consultas de candidatos e sem lista de ids como
 *      parâmetro (antes: 5 pré-consultas `ILIKE`, ~13 mil ids de volta ao Node,
 *      `contactId IN (…)` no findMany da pré-resolução);
 *   2) o fragmento cobre o contrato: título, nome/e-mail/telefone, número do
 *      negócio, campos personalizados, termo numérico por dígitos (com a
 *      expressão exata dos índices) e termo curto por prefixo;
 *   3) `prismaWhere()` (lista, exportação, "carregar mais") resolve os ids numa
 *      consulta só, memoizada, com teto e `capped`;
 *   4) a lista (`getDeals`) estreita a consulta de ids pelo que já traduz e não
 *      dispara `COUNT` com `withTotal=false`;
 *   5) a visibilidade continua em AND com a busca nos dois caminhos.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma as PrismaRuntime, type Prisma } from "@prisma/client";

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

import { runWithContext } from "@/lib/request-context";
import { ServerTiming } from "@/lib/server-timing";
import { getBoardData, getBoardJson, getDeals } from "@/services/deals";
import {
  buildDealSearchOr,
  createDealSearch,
  SEARCH_SHORT_TERM_MAX,
} from "@/services/kanban-filters";

const ORG = "org-search";
const PIPELINE = "pipe-1";
const STAGE_COUNT = 8;
const CONTACTS_ANA = 10_000;
const DEALS = 12_000;

const withOrg = <T>(fn: () => Promise<T>) =>
  runWithContext(
    { organizationId: ORG, userId: "u1", isSuperAdmin: false, actor: "USER" } as never,
    fn,
  );

// ---------------------------------------------------------------------------
// Fixture: 10 mil contatos "ana" + 12 mil negócios abertos.
// ---------------------------------------------------------------------------

type DealRow = {
  id: string;
  title: string;
  status: string;
  stageId: string;
  contactId: string;
  position: number;
  updatedAt: Date;
  organizationId: string;
};

const stages = Array.from({ length: STAGE_COUNT }, (_, i) => ({
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

const deals: DealRow[] = Array.from({ length: DEALS }, (_, i) => ({
  id: `d${i}`,
  title: `Negócio ${i}`,
  status: "OPEN",
  stageId: `s${(i % STAGE_COUNT) + 1}`,
  contactId: `c${Math.floor(i / STAGE_COUNT) % CONTACTS_ANA}`,
  position: i,
  updatedAt: new Date(Date.UTC(2026, 9, 1) + i * 1000),
  organizationId: ORG,
}));

/** Texto e valores de uma chamada `$queryRaw` (template ou `Prisma.Sql`). */
function parseRawCall(call: unknown[]): { text: string; values: unknown[] } {
  const first = call[0] as TemplateStringsArray | Prisma.Sql;
  // Em template, os `Prisma.Sql` aninhados chegam como valores: achata como o Prisma.
  const sql = Array.isArray(first)
    ? PrismaRuntime.sql(first as TemplateStringsArray, ...call.slice(1))
    : (first as Prisma.Sql);
  return { text: sql.strings.join("?"), values: sql.values };
}

/** Quantos valores escalares foram enviados como parâmetro (arrays contam cada item). */
function countBindValues(values: unknown[]): number {
  return values.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
}

/**
 * Emulação mínima do banco:
 *   - janela ranqueada (`PARTITION BY d."stageId"`): metade dos negócios casa
 *     ("Ana …"); devolve `maxPerStage` por etapa e o total da etapa;
 *   - consulta de ids da busca (`SELECT d.id FROM deals d`): mais recentes
 *     primeiro, limitada ao `LIMIT` enviado;
 *   - prévia de cards: vazio.
 */
function installDb() {
  // Metade dos contatos é "Ana …"; o contato muda a cada 8 negócios (uma volta de etapas).
  const matches = (d: DealRow) =>
    d.status === "OPEN" && Math.floor(Number(d.id.slice(1)) / STAGE_COUNT) % 2 === 0;
  h.stageFindMany.mockImplementation(async () => stages);
  h.queryRaw.mockImplementation(async (...call: unknown[]) => {
    const { text, values } = parseRawCall(call);
    if (text.includes('PARTITION BY d."stageId"')) {
      const maxPerStage = Number(values.at(-1));
      const byStage = new Map<string, DealRow[]>();
      for (const d of deals) {
        if (!matches(d)) continue;
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
    if (text.includes("SELECT d.id FROM deals d")) {
      const limit = Number(values.at(-1));
      return deals
        .filter(matches)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit)
        .map((d) => ({ id: d.id }));
    }
    return [];
  });
  // `id IN (…)` direto no where (hidratação) ou dentro de um AND (lista).
  const idsOf = (where: unknown): string[] => {
    if (!where || typeof where !== "object") return [];
    const w = where as { id?: { in?: string[] }; AND?: unknown[] };
    if (Array.isArray(w.id?.in)) return w.id.in;
    for (const sub of w.AND ?? []) {
      const found = idsOf(sub);
      if (found.length > 0) return found;
    }
    return [];
  };
  h.dealFindMany.mockImplementation(
    async (args: { where?: unknown; skip?: number; take?: number }) => {
      const ids = idsOf(args.where).slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? Infinity));
      const byId = new Map(deals.map((d) => [d.id, d]));
      return ids
        .map((id) => byId.get(id))
        .filter((d): d is DealRow => Boolean(d))
        .map((d) => ({
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

beforeEach(() => {
  h.queryRaw.mockReset();
  h.stageFindMany.mockReset();
  h.dealFindMany.mockReset();
  h.dealGroupBy.mockReset();
  h.dealCount.mockReset();
});

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");
const migrationSql = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8");

const rankedCalls = () =>
  h.queryRaw.mock.calls
    .map((c) => parseRawCall(c))
    .filter((r) => r.text.includes('PARTITION BY d."stageId"'));

// ---------------------------------------------------------------------------

describe("board com busca: a busca vai dentro da consulta do board", () => {
  it('"ana" (termo curto): 1 janela + 1 hidratação, sem pré-consulta e sem lista de ids', async () => {
    installDb();
    const timing = new ServerTiming();
    const { json } = await withOrg(() =>
      getBoardJson(PIPELINE, null, "OPEN", { search: "ana" }, { perStage: 50 }, { timing }),
    );
    const board = JSON.parse(json) as { totalCount: number; deals: unknown[] }[];

    // 50 por etapa; total por etapa vem da própria janela.
    expect(board).toHaveLength(STAGE_COUNT);
    for (const stage of board) {
      expect(stage.deals).toHaveLength(50);
      expect(stage.totalCount).toBe(DEALS / STAGE_COUNT / 2);
    }

    // Uma janela; nenhuma pré-consulta de candidatos; nenhum groupBy.
    const raw = h.queryRaw.mock.calls.map((c) => parseRawCall(c));
    const ranked = rankedCalls();
    expect(ranked).toHaveLength(1);
    expect(raw.some((r) => /SELECT id FROM contacts\s+WHERE/.test(r.text))).toBe(false);
    expect(raw.some((r) => r.text.includes("SELECT d.id FROM deals d"))).toBe(false);
    expect(h.dealGroupBy).not.toHaveBeenCalled();
    expect(h.dealFindMany).toHaveBeenCalledTimes(1); // hidratação por id IN (≤ 400 ids)
    const hydrate = h.dealFindMany.mock.calls[0]![0] as { where: { id: { in: string[] } } };
    expect(hydrate.where.id.in.length).toBe(STAGE_COUNT * 50);

    // O termo vai como parâmetro; nada de lista de ids na janela.
    const window = ranked[0]!;
    expect(window.text).toContain('d."contactId" IN (');
    expect(window.text).toContain("c.name ILIKE ?");
    expect(window.values).toContain("ana%");
    expect(window.values).toContain("% ana%");
    expect(window.values).not.toContain("%ana%");
    expect(countBindValues(window.values)).toBeLessThan(STAGE_COUNT + 12);

    // Server-Timing: consulta final medida; sem pré-consulta nem ids.
    const t = timing.toJSON();
    expect(typeof t["search.apply"]).toBe("number");
    expect(t["search.pre"]).toBeUndefined();
    expect(t["search.ids"]).toBeUndefined();
  });

  it("visibilidade do usuário continua em AND com a busca (dentro da mesma janela)", async () => {
    installDb();
    await withOrg(() =>
      getBoardData(PIPELINE, { ownerId: "u1" }, "OPEN", { search: "anabela" }, { perStage: 10 }),
    );
    const window = rankedCalls()[0]!;
    expect(window.text).toContain('d."ownerId" = ?');
    expect(window.text).toContain("c.name ILIKE ?");
    expect(window.values).toContain("u1");
    expect(window.values).toContain("%anabela%");
  });

  it("visibilidade que o tradutor não cobre: ids em UMA consulta estreitada, Prisma avalia o where inteiro", async () => {
    installDb();
    const visibility = { contact: { is: { conversations: { some: { status: "OPEN" } } } } };
    await withOrg(() =>
      getBoardData(
        PIPELINE,
        visibility as Prisma.DealWhereInput,
        "OPEN",
        { search: "betina" },
        { perStage: 10 },
      ),
    );
    const idQueries = h.queryRaw.mock.calls
      .map((c) => parseRawCall(c))
      .filter((r) => r.text.includes("SELECT d.id FROM deals d"));
    expect(idQueries).toHaveLength(1);
    // Estreitada pelo status e pelas etapas do board (o que traduz).
    expect(idQueries[0]!.text).toContain('d."status" = ?::"DealStatus"');
    expect(idQueries[0]!.text).toContain('d."stageId" = ANY(?)');
    // A pré-resolução do board é um findMany com a visibilidade E a busca.
    const pre = h.dealFindMany.mock.calls[0]![0] as { where: { AND: unknown[] } };
    const flat = JSON.stringify(pre.where);
    expect(flat).toContain('"conversations"');
    expect(flat).toContain('"id":{"in"');
    expect(flat).not.toContain('"contactId":{"in"');
  });

  it("termo de 4+ caracteres: título, nome, e-mail e campos personalizados, cada um como subconsulta com LIMIT", async () => {
    installDb();
    await withOrg(() =>
      getBoardData(PIPELINE, null, "OPEN", { search: "mariana" }, { perStage: 10 }),
    );
    const ranked = rankedCalls()[0]!;
    expect(ranked.text).toContain("d.title ILIKE ?");
    expect(ranked.text).toContain("c.name ILIKE ?");
    expect(ranked.text).toContain("c.email ILIKE ?");
    expect(ranked.text).toContain("FROM contact_custom_field_values v");
    expect(ranked.text).toContain("FROM deal_custom_field_values v");
    expect(ranked.text).not.toContain("c.phone ILIKE"); // termo com letra nunca casa telefone
    expect(ranked.text).toContain(" UNION ALL ");
    expect(ranked.values.filter((v) => v === "%mariana%")).toHaveLength(5);
    expect(ranked.values.filter((v) => v === 5000)).toHaveLength(2); // só campos personalizados têm teto de 5000
  });
});

describe("fragmento SQL da busca (contrato)", () => {
  const sqlOf = (term: string) => withOrg(async () => createDealSearch(term)!.sql);

  it("termo curto: título e nome por prefixo de palavra; sem e-mail nem campos personalizados", async () => {
    const sql = await sqlOf("ana");
    const text = sql.strings.join("?");
    expect(text).toContain("d.title ILIKE ? OR d.title ILIKE ?");
    expect(text).toContain("c.name ILIKE ? OR c.name ILIKE ?");
    expect(text).not.toContain("email");
    expect(text).not.toContain("custom_field_values");
    expect(sql.values).toEqual(["ana%", "% ana%", ORG, "ana%", "% ana%", 20_000]);
    expect(SEARCH_SHORT_TERM_MAX).toBe(3);
  });

  it("termo curto com dígitos: prefixo + sufixo do telefone por dígitos + número do negócio", async () => {
    const sql = await sqlOf("123");
    const text = sql.strings.join("?");
    expect(text).toContain("reverse(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g')) LIKE ?");
    expect(text).toContain("d.number = ?");
    expect(sql.values).toContain("321%");
    expect(sql.values).toContain(123);
    expect(text).not.toContain("custom_field_values");
  });

  it("termo numérico (CPF com máscara): dígitos normalizados com a expressão exata dos índices; sem ILIKE em nome/e-mail", async () => {
    const indexExpr = /deal_cfv_value_digits_trgm_idx"[\s\S]*?\(\((regexp_replace\(value, '[^']*', '', 'g'\))\)/.exec(
      migrationSql("20260911220000_db_index_hygiene"),
    )![1]!;
    const sql = await sqlOf("123.456.789-00");
    const text = sql.strings.join("?");
    expect(text).toContain(indexExpr.replace("regexp_replace(value", "regexp_replace(v.value"));
    expect(text).not.toContain("'D'");
    expect(text).not.toContain("c.name ILIKE");
    expect(text).not.toContain("c.email ILIKE");
    expect(text).toContain("d.title ILIKE ?");
    expect(text).toContain("FROM deal_custom_field_values v");
    expect(text).toContain("FROM contact_custom_field_values v");
    expect(sql.values).toContain("%12345678900%");
    expect(sql.values).toContain("00987654321%"); // sufixo do telefone, invertido
    expect(text).not.toContain("d.number = ?"); // não é só dígitos
  });

  it("número do negócio só até int4; `%`/`_` do termo viram literais", async () => {
    expect((await sqlOf("99999999999")).strings.join("?")).not.toContain("d.number = ?");
    expect((await sqlOf("4321")).values).toContain(4321);
    expect((await sqlOf("50%_x")).values[0]).toBe("%50\\%\\_x%");
  });

  it("telefone parcial com máscara e pontuação (termo só de dígitos e símbolos) também casa por ILIKE", async () => {
    expect((await sqlOf("(11) 94")).strings.join("?")).toContain("c.phone ILIKE ?");
  });

  it("sem organização no contexto: só título e número (where Prisma, sem consulta)", async () => {
    const search = createDealSearch("ana")!;
    expect(search.sql.strings.join("?")).not.toContain("contacts");
    await expect(search.prismaWhere()).resolves.toEqual({
      OR: [{ title: { contains: "ana", mode: "insensitive" } }],
    });
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(createDealSearch("   ")).toBeNull();
  });
});

describe("prismaWhere(): ids numa consulta, memoizada, com teto", () => {
  it("uma consulta; `id IN`, `search.pre` e `search.ids` no timing", async () => {
    installDb();
    const timing = new ServerTiming();
    const where = await withOrg(async () => {
      const search = createDealSearch("ana", { timing })!;
      const [a, b] = await Promise.all([
        search.prismaWhere({ idsCap: 100 }),
        search.prismaWhere({ idsCap: 100 }),
      ]);
      expect(a).toBe(b);
      expect(search.resolved()).toEqual({ ids: 100, capped: true });
      return a;
    });
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = parseRawCall(h.queryRaw.mock.calls[0]!);
    expect(text).toContain('ORDER BY d."updatedAt" DESC, d.id DESC');
    expect(values.at(-1)).toBe(101);
    expect((where as { id: { in: string[] } }).id.in).toHaveLength(100);
    const t = timing.toJSON();
    expect(t["search.ids"]).toBe(100);
    expect(t["search.preDesc"]).toBe("capped");
    expect(typeof t["search.pre"]).toBe("number");
  });

  it("buildDealSearchOr (exportação/painéis) devolve um `id IN` só", async () => {
    installDb();
    const or = await withOrg(() => buildDealSearchOr("ana", { idsCap: 10 }));
    expect(or).toHaveLength(1);
    expect((or[0] as { id: { in: string[] } }).id.in).toHaveLength(10);
    expect(await buildDealSearchOr("  ")).toEqual([]);
  });
});

describe("lista (GET /api/deals?search=): mesma busca, estreitada, sem COUNT com withTotal=false", () => {
  it("consulta de ids com status e funil já aplicados; `searchCapped` na resposta", async () => {
    installDb();
    // 6 mil negócios casam; teto da lista = max(2000, skip + perPage + 1) = 2000.
    const res = await withOrg(() =>
      getDeals({ search: "ana", pipelineId: PIPELINE, status: "OPEN", perPage: 8, withTotal: false }),
    );
    expect(h.dealCount).not.toHaveBeenCalled();
    expect(res.total).toBeNull();
    expect(res.hasMore).toBe(true);
    expect(res.searchCapped).toBe(true);

    const idQueries = h.queryRaw.mock.calls
      .map((c) => parseRawCall(c))
      .filter((r) => r.text.includes("SELECT d.id FROM deals d"));
    expect(idQueries).toHaveLength(1);
    expect(h.queryRaw.mock.calls.filter((c) => !parseRawCall(c).text.includes("conversations")))
      .toHaveLength(1); // nenhuma das 5 pré-consultas antigas
    const { text, values } = idQueries[0]!;
    expect(text).toContain('d."status" = ?::"DealStatus"');
    expect(text).toContain('d."stageId" IN (SELECT st.id FROM stages st WHERE st."pipelineId" = ?)');
    expect(values).toContain(PIPELINE);
    expect(values.at(-1)).toBe(2001);

    // O findMany da página recebe `id IN (…)` — nunca `contactId IN (…)`.
    const args = h.dealFindMany.mock.calls[0]![0] as { where: { AND: Prisma.DealWhereInput[] } };
    expect(JSON.stringify(args.where)).not.toContain('"contactId":{"in"');
    expect(
      args.where.AND.some((c) => Array.isArray((c as { id?: { in?: string[] } }).id?.in)),
    ).toBe(true);
  });

  it("teto acompanha a página pedida (página fundo não fica sem resultado), com máximo de 5000", async () => {
    installDb();
    await withOrg(() => getDeals({ search: "ana", page: 400, perPage: 20, withTotal: false }));
    const { values } = parseRawCall(h.queryRaw.mock.calls[0]!);
    expect(values.at(-1)).toBe(5001);
  });

  it("sem busca nada muda: nenhuma consulta de ids", async () => {
    installDb();
    await withOrg(() => getDeals({ pipelineId: PIPELINE, perPage: 8, withTotal: false }));
    expect(h.queryRaw.mock.calls.some((c) => parseRawCall(c).text.includes("SELECT d.id FROM deals d"))).toBe(false);
  });
});
