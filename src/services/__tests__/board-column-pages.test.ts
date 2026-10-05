/**
 * P-14 / BD-17 — "Carregar mais" de uma coluna do board por cursor.
 *
 * Banco falso em memória (sem Postgres/Redis):
 *   - `prisma.deal.findMany` avalia o `where`/`orderBy`/`take` Prisma de
 *     verdade (`@/test-setup/fake-db`) — é o caminho real das páginas em
 *     `position`/`createdAt`, keyset incluído;
 *   - `prisma.$queryRaw` emula as janelas do board e a página de
 *     `lastInteraction` sobre a mesma fixture.
 *
 * O que é provado:
 *   1) board → `nextCursor` por etapa → páginas: a concatenação é a coluna
 *      inteira, na ordem, sem repetir nem pular, com empate em `position` e
 *      em `createdAt`;
 *   2) card que muda de posição entre páginas (semântica documentada em
 *      `board-column-cursor.ts`);
 *   3) visibilidade/status/pipeline preservados (o where é o do board);
 *   4) sem `skip`/OFFSET, sem cache, e menos consultas que o recarregamento
 *      antigo (`offsetByStage`), que continua funcionando;
 *   5) os cards têm o mesmo formato do board;
 *   6) cursor inválido / de outra ordenação → erro do cliente;
 *   7) `lastInteraction`: cursor com `last_at`, NULLS LAST, e sem cursor no
 *      fallback em memória.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn(),
    stageFindMany: vi.fn(),
    dealFindMany: vi.fn(),
    dealGroupBy: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    stage: { findMany: h.stageFindMany },
    deal: { findMany: h.dealFindMany, groupBy: h.dealGroupBy },
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
vi.mock("@/services/analytics", () => ({
  getStageMetrics: vi.fn(async () => []),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async () => undefined),
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/services/kanban-filters", () => ({
  buildDealSearchOr: vi.fn(async () => []),
  buildDealWhereFromFilters: vi.fn(async () => []),
}));

import { cache } from "@/lib/cache";
import { runWithContext } from "@/lib/request-context";
import {
  boardColumnKeysetWhere,
  encodeBoardColumnCursor,
  parseBoardColumnCursor,
} from "@/services/board-column-cursor";
import {
  BoardColumnPageError,
  buildLastInteractionColumnPageSql,
  getBoardColumnPages,
  getBoardData,
} from "@/services/deals";
import { FakeDb, type FakeDbSchema } from "@/test-setup/fake-db";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ORG = "org-board";
const PIPELINE = "pipe-1";
const T0 = Date.UTC(2026, 0, 1);
const at = (min: number) => new Date(T0 + min * 60_000);

const SCHEMA: FakeDbSchema = {
  deal: { stage: { kind: "one", table: "stage", localKey: "stageId" } },
};

type DealRow = {
  id: string;
  organizationId: string;
  stageId: string;
  position: number;
  status: "OPEN" | "WON" | "LOST";
  ownerId: string | null;
  contactId: string | null;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

const stageRow = (id: string, position: number, pipelineId = PIPELINE) => ({
  id,
  organizationId: ORG,
  pipelineId,
  name: id,
  slug: id,
  number: position,
  position,
  color: "#000",
  winProbability: 0,
  rottingDays: 30,
  isIncoming: false,
  isWon: false,
  isLost: false,
  requiredDealFieldIds: [],
});

let seq = 0;
function deal(
  id: string,
  stageId: string,
  position: number,
  createdMin: number,
  extra: Partial<DealRow> = {},
): DealRow {
  seq += 1;
  return {
    id,
    organizationId: ORG,
    stageId,
    position,
    status: "OPEN",
    ownerId: "u1",
    contactId: null,
    title: `Deal ${id}`,
    createdAt: at(createdMin),
    // updatedAt distinto por deal (candidatos do lastInteraction)
    updatedAt: at(1000 - seq),
    ...extra,
  };
}

/**
 * s1: 12 cards OPEN com empates em `position` (1,1,1 / 2,2 / 3,3,3,3) e em
 * `createdAt`; ids fora de ordem alfabética em relação à inserção, para o
 * desempate por id aparecer. s2: 3 cards. sx: etapa de OUTRO pipeline.
 */
function seedDeals(): DealRow[] {
  seq = 0;
  return [
    deal("d-c", "s1", 1, 5),
    deal("d-a", "s1", 1, 5),
    deal("d-b", "s1", 1, 7),
    deal("d-e", "s1", 2, 7),
    deal("d-d", "s1", 2, 7, { ownerId: "u2" }),
    deal("d-i", "s1", 3, 9),
    deal("d-g", "s1", 3, 9, { ownerId: "u2" }),
    deal("d-h", "s1", 3, 2),
    deal("d-f", "s1", 3, 2),
    deal("d-j", "s1", 4, 1),
    deal("d-k", "s1", 5, 3, { ownerId: null }),
    deal("d-l", "s1", 5.5, 3),
    deal("d-lost", "s1", 2.5, 4, { status: "LOST" }),
    deal("e-1", "s2", 1, 1),
    deal("e-2", "s2", 2, 2),
    deal("e-3", "s2", 3, 3),
    deal("x-1", "sx", 1, 1),
    deal("x-2", "sx", 2, 2),
  ];
}

let db: FakeDb;
/** `where` Prisma do cenário — o SQL cru emulado filtra a fixture por ele. */
let currentWhere: Record<string, unknown> = { status: "OPEN" };
/** Última atividade de conversa por contato (lastInteraction). */
let lastAtByContact = new Map<string, Date>();

const deals = () => db.table("deal") as unknown as DealRow[];
const byId = (id: string) => deals().find((d) => d.id === id)!;

function parseRawCall(call: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = call;
  if (!Array.isArray(first)) {
    const sql = first as Prisma.Sql;
    return { text: sql.strings.join("?"), values: [...sql.values] };
  }
  return { text: (first as readonly string[]).join("?"), values: rest };
}

function cmpId(a: DealRow, b: DealRow) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function lastAtOf(d: DealRow): number | null {
  const v = d.contactId ? lastAtByContact.get(d.contactId) : undefined;
  return v ? v.getTime() : null;
}

/** `last_at <dir> NULLS LAST, position ASC, id ASC`. */
function cmpLastInteraction(dir: "asc" | "desc") {
  const mul = dir === "desc" ? -1 : 1;
  return (a: DealRow, b: DealRow) => {
    const la = lastAtOf(a);
    const lb = lastAtOf(b);
    if (la != null && lb != null && la !== lb) return (la - lb) * mul;
    if (la != null && lb == null) return -1;
    if (la == null && lb != null) return 1;
    if (a.position !== b.position) return a.position - b.position;
    return cmpId(a, b);
  };
}

function candidates(stageId: string, scanCap: number): DealRow[] {
  return deals()
    .filter((d) => d.stageId === stageId && db.matches("deal", d, currentWhere))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || cmpId(b, a))
    .slice(0, scanCap);
}

function emulateRaw(call: unknown[]): unknown[] {
  const { text, values } = parseRawCall(call);

  // Página de UMA etapa em lastInteraction (getBoardColumnPages).
  if (text.includes("WITH candidates AS") && text.includes("SELECT r.id, r.last_at")) {
    const stageId = values[1] as string;
    const take = values[values.length - 1] as number;
    const cursorId = values[values.length - 2] as string;
    const cursorPosition = values[values.length - 3] as number;
    const nullCursor = /WHERE \(r\.last_at IS NULL AND/.test(text);
    const cursorLastAt = nullCursor ? null : (values[values.length - 4] as Date).getTime();
    const dir = /ORDER BY r\.last_at DESC NULLS LAST/.test(text) ? "desc" : "asc";
    const scanCap = values.find((v, i) => typeof v === "number" && i > 1) as number;
    const afterPosition = (d: DealRow) =>
      d.position > cursorPosition || (d.position === cursorPosition && d.id > cursorId);
    return candidates(stageId, scanCap)
      .filter((d) => {
        const la = lastAtOf(d);
        if (cursorLastAt === null) return la === null && afterPosition(d);
        if (la === null) return true;
        if (la === cursorLastAt) return afterPosition(d);
        return dir === "desc" ? la < cursorLastAt : la > cursorLastAt;
      })
      .sort(cmpLastInteraction(dir))
      .slice(0, take)
      .map((d) => {
        const la = lastAtOf(d);
        return { id: d.id, last_at: la === null ? null : new Date(la) };
      });
  }

  // Board em lastInteraction (todas as etapas, janela por etapa).
  if (text.includes("WITH candidates AS")) {
    const stageIds = values[1] as string[];
    const scanCap = values[values.length - 2] as number;
    const maxPerStage = values[values.length - 1] as number;
    const dir = /last_at DESC NULLS LAST/.test(text) ? "desc" : "asc";
    return stageIds.flatMap((stageId) =>
      candidates(stageId, scanCap)
        .sort(cmpLastInteraction(dir))
        .slice(0, maxPerStage)
        .map((d, i) => {
          const la = lastAtOf(d);
          return { id: d.id, stageId, rn: i + 1, last_at: la === null ? null : new Date(la) };
        }),
    );
  }

  // Board em position/createdAt (janela por etapa).
  if (text.includes('PARTITION BY d."stageId"')) {
    const stageIds = values[1] as string[];
    const maxPerStage = values[values.length - 1] as number;
    const createdDir = /d\."createdAt" DESC/.test(text)
      ? -1
      : /d\."createdAt" ASC/.test(text)
        ? 1
        : 0;
    return stageIds.flatMap((stageId) =>
      deals()
        .filter((d) => d.stageId === stageId && db.matches("deal", d, currentWhere))
        .sort((a, b) => {
          if (createdDir !== 0 && a.createdAt.getTime() !== b.createdAt.getTime()) {
            return (a.createdAt.getTime() - b.createdAt.getTime()) * createdDir;
          }
          if (a.position !== b.position) return a.position - b.position;
          return cmpId(a, b);
        })
        .slice(0, maxPerStage)
        .map((d, i) => ({ id: d.id, stageId, rn: i + 1 })),
    );
  }

  if (text.includes("FROM deal_products")) return [];
  if (text.includes("contact_unread")) return [];
  if (text.includes('PARTITION BY c."contactId", m.direction')) return [];
  throw new Error(`SQL cru não emulado: ${text.slice(0, 120)}`);
}

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: ORG } as Parameters<typeof runWithContext>[0],
    fn,
  ) as Promise<T>;
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb(SCHEMA);
  db.insert("stage", stageRow("s1", 1), stageRow("s2", 2), stageRow("sx", 1, "pipe-other"));
  db.insert("deal", ...seedDeals());
  currentWhere = { status: "OPEN" };
  lastAtByContact = new Map();

  h.queryRaw.mockReset().mockImplementation(async (...call: unknown[]) => emulateRaw(call));
  h.stageFindMany.mockReset().mockImplementation(async (args: Record<string, unknown>) =>
    db.run("stage", "findMany", args),
  );
  h.dealFindMany.mockReset().mockImplementation(async (args: Record<string, unknown>) => {
    const rows = db.run("deal", "findMany", args) as Record<string, unknown>[];
    return args.include
      ? rows.map((r) => ({ ...r, contact: null, owner: null, tags: [], activities: [] }))
      : rows;
  });
  h.dealGroupBy.mockReset().mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const counts = new Map<string, number>();
    for (const d of deals().filter((row) => db.matches("deal", row, args.where))) {
      counts.set(d.stageId, (counts.get(d.stageId) ?? 0) + 1);
    }
    return [...counts].map(([stageId, n]) => ({ stageId, _count: { _all: n } }));
  });
  // Sem cache entre chamadas: cada teste muda a fixture.
  vi.spyOn(cache, "wrap").mockImplementation(((_k: string, _t: number, fn: () => unknown) =>
    fn()) as typeof cache.wrap);
});

type Sort = { sortField?: "position" | "createdAt" | "lastInteraction"; sortDirection?: "asc" | "desc" };

async function loadBoard(perStage: number, sort: Sort = {}, visibility: Prisma.DealWhereInput | null = null) {
  return withOrg(() =>
    getBoardData(PIPELINE, visibility, undefined, undefined, { perStage, ...sort }),
  );
}

/** Board + todas as páginas da etapa pelo cursor. Devolve os ids por página. */
async function readColumn(
  stageId: string,
  perStage: number,
  limit: number,
  sort: Sort = {},
  visibility: Prisma.DealWhereInput | null = null,
  between?: (pageIndex: number) => void,
) {
  const board = await loadBoard(perStage, sort, visibility);
  const stage = board.find((s) => s.id === stageId)!;
  const pages: string[][] = [stage.deals.map((d) => d.id)];
  let cursor = stage.nextCursor;
  for (let i = 0; cursor && i < 50; i += 1) {
    between?.(i);
    const [page] = await withOrg(() =>
      getBoardColumnPages(PIPELINE, visibility, undefined, undefined, {
        ...sort,
        columns: [{ stageId, cursor: cursor as string, limit }],
      }),
    );
    pages.push(page!.deals.map((d) => d.id));
    cursor = page!.nextCursor;
    expect(page!.hasMore).toBe(cursor !== null);
  }
  return pages;
}

const S1_BY_POSITION = [
  "d-a", "d-b", "d-c", // position 1
  "d-d", "d-e", // 2
  "d-f", "d-g", "d-h", "d-i", // 3
  "d-j", // 4
  "d-k", // 5
  "d-l", // 5.5
];

// ---------------------------------------------------------------------------
// 1) Páginas por cursor: sem repetir nem pular, com empate
// ---------------------------------------------------------------------------

describe("coluna por cursor — ordem e empates", () => {
  it("position: cortes no meio dos empates (página de 2) remontam a coluna inteira", async () => {
    const pages = await readColumn("s1", 2, 2);
    expect(pages.flat()).toEqual(S1_BY_POSITION);
    expect(pages.every((p) => p.length <= 2)).toBe(true);
    expect(pages).toHaveLength(6);
  });

  it("position: tamanhos de página diferentes do board (4 + páginas de 3)", async () => {
    const pages = await readColumn("s1", 4, 3);
    expect(pages.flat()).toEqual(S1_BY_POSITION);
    expect(pages[0]).toHaveLength(4);
  });

  it("createdAt desc: createdAt desc, position asc, id asc", async () => {
    const expected = [
      "d-g", "d-i", // min 9, position 3
      "d-b", "d-d", "d-e", // min 7: position 1, depois 2 (d-d < d-e)
      "d-a", "d-c", // min 5, position 1
      "d-k", "d-l", // min 3: position 5, 5.5
      "d-f", "d-h", // min 2, position 3
      "d-j", // min 1
    ];
    const pages = await readColumn("s1", 3, 2, { sortField: "createdAt", sortDirection: "desc" });
    expect(pages.flat()).toEqual(expected);
  });

  it("createdAt asc", async () => {
    const expected = [
      "d-j",
      "d-f", "d-h",
      "d-k", "d-l",
      "d-a", "d-c",
      "d-b", "d-d", "d-e",
      "d-g", "d-i",
    ];
    const pages = await readColumn("s1", 2, 3, { sortField: "createdAt", sortDirection: "asc" });
    expect(pages.flat()).toEqual(expected);
  });

  it("etapa sem mais cards: board já diz hasMore=false e nextCursor=null", async () => {
    const board = await loadBoard(10);
    const s2 = board.find((s) => s.id === "s2")!;
    expect(s2.hasMore).toBe(false);
    expect(s2.nextCursor).toBeNull();
    const s1 = board.find((s) => s.id === "s1")!;
    expect(s1.hasMore).toBe(true);
    expect(typeof s1.nextCursor).toBe("string");
  });

  it("várias etapas num pedido: cada uma segue o próprio cursor", async () => {
    const board = await loadBoard(1);
    const columns = board
      .filter((s) => s.nextCursor)
      .map((s) => ({ stageId: s.id, cursor: s.nextCursor as string, limit: 2 }));
    expect(columns.map((c) => c.stageId)).toEqual(["s1", "s2"]);
    const pages = await withOrg(() =>
      getBoardColumnPages(PIPELINE, null, undefined, undefined, { columns }),
    );
    expect(pages.map((p) => [p.stageId, p.deals.map((d) => d.id), p.hasMore])).toEqual([
      ["s1", ["d-b", "d-c"], true],
      ["s2", ["e-2", "e-3"], false],
    ]);
    expect(pages[1]!.nextCursor).toBeNull();
    // total ATUAL da etapa (mesmo where do board) vem junto com a página
    expect(pages.map((p) => p.totalCount)).toEqual([12, 3]);
  });
});

// ---------------------------------------------------------------------------
// 2) Cards que mudam de posição entre páginas
// ---------------------------------------------------------------------------

describe("coluna por cursor — card que muda de posição entre páginas", () => {
  it("card ainda não carregado que sobe para antes do cursor não vem nas páginas seguintes (entra no próximo recarregamento); os parados não são pulados", async () => {
    const pages = await readColumn("s1", 3, 3, {}, null, (i) => {
      if (i === 0) byId("d-j").position = 0.5; // vai para o topo
    });
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toEqual(S1_BY_POSITION.filter((id) => id !== "d-j"));

    const reloaded = await loadBoard(3);
    expect(reloaded.find((s) => s.id === "s1")!.deals.map((d) => d.id)).toEqual([
      "d-j", "d-a", "d-b",
    ]);
  });

  it("card já carregado que desce para depois do cursor vem de novo (o cliente deduplica por id); nenhum outro é pulado", async () => {
    const pages = await readColumn("s1", 3, 3, {}, null, (i) => {
      if (i === 0) byId("d-a").position = 4.5; // estava na 1ª página
    });
    const flat = pages.flat();
    expect(flat.filter((id) => id === "d-a")).toHaveLength(2);
    // sem o repetido, a ordem dos demais é a de sempre
    expect(flat.filter((id, idx) => id !== "d-a" || idx === 0)).toEqual(S1_BY_POSITION);
    // e a segunda aparição está na nova posição (entre d-j e d-k)
    const again = flat.lastIndexOf("d-a");
    expect(flat[again - 1]).toBe("d-j");
    expect(flat[again + 1]).toBe("d-k");
  });

  it("card que sai da etapa entre páginas some das páginas seguintes; card novo no fim aparece", async () => {
    const pages = await readColumn("s1", 3, 3, {}, null, (i) => {
      if (i !== 0) return;
      byId("d-h").stageId = "s2";
      db.insert("deal", deal("d-new", "s1", 9, 50));
    });
    expect(pages.flat()).toEqual([
      ...S1_BY_POSITION.filter((id) => id !== "d-h"),
      "d-new",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3) Visibilidade / status / pipeline
// ---------------------------------------------------------------------------

describe("coluna por cursor — escopo", () => {
  it("visibilidade do usuário vale em todas as páginas (mesmo where do board)", async () => {
    const visibility: Prisma.DealWhereInput = { ownerId: "u1" };
    currentWhere = { AND: [{ status: "OPEN" }, visibility] };
    const pages = await readColumn("s1", 2, 2, {}, visibility);
    const u1 = S1_BY_POSITION.filter((id) => byId(id).ownerId === "u1");
    expect(u1).toHaveLength(9);
    expect(pages.flat()).toEqual(u1);

    // o total devolvido com a página respeita a mesma visibilidade
    const cursor = encodeBoardColumnCursor({ sort: "position", direction: "asc", position: 0, id: "a" });
    const [page] = await withOrg(() =>
      getBoardColumnPages(PIPELINE, visibility, undefined, undefined, {
        columns: [{ stageId: "s1", cursor, limit: 2 }],
      }),
    );
    expect(page!.totalCount).toBe(9);
  });

  it("status padrão OPEN: card LOST da etapa nunca entra", async () => {
    const pages = await readColumn("s1", 5, 5);
    expect(pages.flat()).not.toContain("d-lost");
  });

  it("etapa de outro pipeline é ignorada (nem é consultada)", async () => {
    const cursor = encodeBoardColumnCursor({ sort: "position", direction: "asc", position: 0, id: "a" });
    const pages = await withOrg(() =>
      getBoardColumnPages(PIPELINE, null, undefined, undefined, {
        columns: [{ stageId: "sx", cursor, limit: 5 }],
      }),
    );
    expect(pages).toEqual([]);
    expect(h.dealFindMany).not.toHaveBeenCalled();
  });

  it("o where da página é AND de [where do board, etapa, keyset] — a etapa não sobrescreve um stageId da visibilidade", async () => {
    const visibility: Prisma.DealWhereInput = { stageId: { in: ["s2"] } };
    const cursor = encodeBoardColumnCursor({ sort: "position", direction: "asc", position: 0, id: "a" });
    const [page] = await withOrg(() =>
      getBoardColumnPages(PIPELINE, visibility, undefined, undefined, {
        columns: [{ stageId: "s1", cursor, limit: 5 }],
      }),
    );
    // visibilidade só enxerga s2 → pedir s1 não devolve nada
    expect(page!.deals).toEqual([]);
    const where = (h.dealFindMany.mock.calls[0]![0] as { where: { AND: unknown[] } }).where;
    expect(where.AND).toHaveLength(3);
    expect(where.AND[1]).toEqual({ stageId: "s1" });
  });
});

// ---------------------------------------------------------------------------
// 4) Sem OFFSET, sem cache, menos consultas; parâmetro antigo continua
// ---------------------------------------------------------------------------

describe("coluna por cursor — custo", () => {
  it("consulta da página: sem skip, take = limit + 1, ordem com id, limite inferior na coluna líder", async () => {
    const board = await loadBoard(3);
    const cursor = board.find((s) => s.id === "s1")!.nextCursor!;
    h.dealFindMany.mockClear();
    await withOrg(() =>
      getBoardColumnPages(PIPELINE, null, undefined, undefined, {
        columns: [{ stageId: "s1", cursor, limit: 4 }],
      }),
    );
    expect(h.dealFindMany).toHaveBeenCalledTimes(1);
    const args = h.dealFindMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.skip).toBeUndefined();
    expect(args.take).toBe(5);
    expect(args.orderBy).toEqual([{ position: "asc" }, { id: "asc" }]);
    // último card do board (3 por etapa) é d-c, position 1
    expect(parseBoardColumnCursor(cursor, "position", "asc")).toMatchObject({
      position: 1,
      id: "d-c",
    });
    expect(boardColumnKeysetWhere(parseBoardColumnCursor(cursor, "position", "asc")!)).toEqual({
      AND: [
        { position: { gte: 1 } },
        { OR: [{ position: { gt: 1 } }, { position: 1, id: { gt: "d-c" } }] },
      ],
    });
  });

  it("não passa pelo cache do board (nenhuma chave por página)", async () => {
    const board = await loadBoard(3);
    const wrap = vi.mocked(cache.wrap);
    expect(wrap).toHaveBeenCalledTimes(1);
    wrap.mockClear();
    let cursor = board.find((s) => s.id === "s1")!.nextCursor;
    while (cursor) {
      const [page] = await withOrg(() =>
        getBoardColumnPages(PIPELINE, null, undefined, undefined, {
          columns: [{ stageId: "s1", cursor: cursor as string, limit: 3 }],
        }),
      );
      cursor = page!.nextCursor;
    }
    expect(wrap).not.toHaveBeenCalled();
  });

  it("uma página custa menos consultas que recarregar o board com offsetByStage (que continua aceito)", async () => {
    const board = await loadBoard(3);
    const cursor = board.find((s) => s.id === "s1")!.nextCursor!;

    const calls = () =>
      h.queryRaw.mock.calls.length +
      h.stageFindMany.mock.calls.length +
      h.dealFindMany.mock.calls.length +
      h.dealGroupBy.mock.calls.length;

    vi.clearAllMocks();
    const [page] = await withOrg(() =>
      getBoardColumnPages(PIPELINE, null, undefined, undefined, {
        columns: [{ stageId: "s1", cursor, limit: 3 }],
      }),
    );
    const cursorCalls = calls();
    // etapas pedidas + página de deals (sem cards com contato → sem consultas
    // de conversa/mensagem; produtos sempre)
    expect(h.stageFindMany).toHaveBeenCalledTimes(1);
    expect(h.dealFindMany).toHaveBeenCalledTimes(1);
    // contagem só das etapas pedidas (o board conta o funil inteiro)
    expect(h.dealGroupBy).toHaveBeenCalledTimes(1);
    expect(
      (h.dealGroupBy.mock.calls[0]![0] as { where: { AND: unknown[] } }).where.AND[1],
    ).toEqual({ stageId: { in: ["s1"] } });
    expect(page!.totalCount).toBe(12);

    vi.clearAllMocks();
    const legacy = await withOrg(() =>
      getBoardData(PIPELINE, null, undefined, undefined, {
        perStage: 3,
        offsetByStage: { s1: 3 },
      }),
    );
    const legacyCalls = calls();
    expect(cursorCalls).toBeLessThan(legacyCalls);

    // mesmo resultado pelos dois caminhos
    const legacyS1 = legacy.find((s) => s.id === "s1")!;
    expect(legacyS1.deals.map((d) => d.id)).toEqual(S1_BY_POSITION.slice(0, 6));
    expect(page!.deals.map((d) => d.id)).toEqual(S1_BY_POSITION.slice(3, 6));
    // e o board antigo também sai com o cursor certo para continuar
    expect(parseBoardColumnCursor(legacyS1.nextCursor, "position", "asc")).toMatchObject({
      id: "d-f",
      position: 3,
    });
    expect(legacyS1.nextCursor).toBe(page!.nextCursor);
  });

  it("limit é limitado a [1, 500]; padrão 20", async () => {
    const cursor = encodeBoardColumnCursor({ sort: "position", direction: "asc", position: 0, id: "a" });
    const take = async (limit: number | undefined) => {
      h.dealFindMany.mockClear();
      await withOrg(() =>
        getBoardColumnPages(PIPELINE, null, undefined, undefined, {
          columns: [{ stageId: "s1", cursor, limit }],
        }),
      );
      return (h.dealFindMany.mock.calls[0]![0] as { take: number }).take;
    };
    expect(await take(undefined)).toBe(21);
    expect(await take(0)).toBe(2);
    expect(await take(10_000)).toBe(501);
    expect(await take(7.9)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 5) Mesmo card do board
// ---------------------------------------------------------------------------

describe("coluna por cursor — formato do card", () => {
  it("cards das páginas são idênticos aos do board carregado de uma vez", async () => {
    const full = await loadBoard(50);
    const fullS1 = full.find((s) => s.id === "s1")!;
    const board = await loadBoard(4);
    const stage = board.find((s) => s.id === "s1")!;
    const collected = [...stage.deals];
    let cursor = stage.nextCursor;
    while (cursor) {
      const [page] = await withOrg(() =>
        getBoardColumnPages(PIPELINE, null, undefined, undefined, {
          columns: [{ stageId: "s1", cursor: cursor as string, limit: 4 }],
        }),
      );
      collected.push(...page!.deals);
      cursor = page!.nextCursor;
    }
    const strip = (cards: unknown) =>
      (JSON.parse(JSON.stringify(cards)) as Record<string, unknown>[]).map((c) => {
        // `isRotting` depende do relógio de cada chamada.
        const { isRotting: _isRotting, ...rest } = c;
        return rest;
      });
    expect(strip(collected)).toEqual(strip(fullS1.deals));
    expect(Object.keys(collected[0]!)).toEqual(
      expect.arrayContaining([
        "id", "position", "isRotting", "productName", "tags", "pendingActivities",
        "unreadCount", "lastMessage", "awaitingMessages", "lastInboundMessage", "channel",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// 6) Erros do cliente
// ---------------------------------------------------------------------------

describe("coluna por cursor — cursor inválido", () => {
  const call = (columns: { stageId: string; cursor: string }[], sort: Sort = {}) =>
    withOrg(() => getBoardColumnPages(PIPELINE, null, undefined, undefined, { ...sort, columns }));

  it("lixo → invalid_cursor, antes de qualquer consulta", async () => {
    await expect(call([{ stageId: "s1", cursor: "###" }])).rejects.toMatchObject({
      name: "BoardColumnPageError",
      code: "invalid_cursor",
    });
    expect(h.stageFindMany).not.toHaveBeenCalled();
    expect(h.dealFindMany).not.toHaveBeenCalled();
  });

  it("cursor emitido para outra ordenação ou direção é recusado", async () => {
    const board = await loadBoard(3, { sortField: "createdAt", sortDirection: "desc" });
    const cursor = board.find((s) => s.id === "s1")!.nextCursor!;
    await expect(call([{ stageId: "s1", cursor }])).rejects.toBeInstanceOf(BoardColumnPageError);
    await expect(
      call([{ stageId: "s1", cursor }], { sortField: "createdAt", sortDirection: "asc" }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      call([{ stageId: "s1", cursor }], { sortField: "createdAt", sortDirection: "desc" }),
    ).resolves.toHaveLength(1);
  });

  it("sem etapas → invalid_request", async () => {
    await expect(call([])).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("cursor é opaco: não expõe id nem posição em texto puro", async () => {
    const board = await loadBoard(3);
    const cursor = board.find((s) => s.id === "s1")!.nextCursor!;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("d-c");
  });
});

// ---------------------------------------------------------------------------
// 7) lastInteraction
// ---------------------------------------------------------------------------

describe("coluna por cursor — lastInteraction", () => {
  beforeEach(() => {
    // contatos: alguns com conversa (com empate de last_at), outros sem.
    const contactOf: Record<string, string> = {
      "d-a": "c1", "d-b": "c2", "d-c": "c3", "d-d": "c4", "d-e": "c5",
      "d-f": "c6", "d-g": "c7",
    };
    for (const [id, contactId] of Object.entries(contactOf)) byId(id).contactId = contactId;
    lastAtByContact = new Map([
      ["c1", at(100)],
      ["c2", at(300)],
      ["c3", at(200)],
      ["c4", at(200)], // empate com c3 → position, id
      ["c5", at(50)],
      // c6, c7: contato sem conversa → NULLS LAST junto com os sem contato
    ]);
  });

  const DESC = [
    "d-b", // 300
    "d-c", "d-d", // 200: position 1 antes de 2
    "d-a", // 100
    "d-e", // 50
    // sem last_at: position asc, id asc
    "d-f", "d-g", "d-h", "d-i", "d-j", "d-k", "d-l",
  ];

  it("desc: páginas remontam a coluna (NULLS LAST, empate por position/id)", async () => {
    const pages = await readColumn("s1", 2, 3, { sortField: "lastInteraction", sortDirection: "desc" });
    expect(pages.flat()).toEqual(DESC);
  });

  it("asc: os sem conversa continuam no fim", async () => {
    const pages = await readColumn("s1", 3, 2, { sortField: "lastInteraction", sortDirection: "asc" });
    expect(pages.flat()).toEqual([
      "d-e", "d-a", "d-c", "d-d", "d-b",
      "d-f", "d-g", "d-h", "d-i", "d-j", "d-k", "d-l",
    ]);
  });

  it("card que recebe mensagem entre páginas sobe para antes do cursor: não duplica", async () => {
    const pages = await readColumn(
      "s1",
      2,
      3,
      { sortField: "lastInteraction", sortDirection: "desc" },
      null,
      (i) => {
        if (i === 0) lastAtByContact.set("c5", at(999)); // d-e ainda não carregado
      },
    );
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toEqual(DESC.filter((id) => id !== "d-e"));
  });

  it("SQL da página: uma etapa, candidatos limitados, keyset com NULLS LAST, sem OFFSET, valores parametrizados", () => {
    const base = {
      orgId: ORG,
      stageId: "s1",
      whereSql: Prisma.sql`d."status" = ${"OPEN"}::"DealStatus"`,
      scanCap: 2500,
      take: 11,
    };
    const withLast = buildLastInteractionColumnPageSql({
      ...base,
      direction: "desc",
      cursor: { sort: "lastInteraction", direction: "desc", position: 2, id: "d-x", lastAt: at(7) },
    });
    const text = withLast.strings.join("?");
    expect(text).not.toMatch(/OFFSET/i);
    expect(text).toMatch(/d\."stageId" = \?/);
    expect(text).toMatch(/ORDER BY d\."updatedAt" DESC, d\.id DESC\s+LIMIT \?/);
    expect(text).toMatch(
      /\(r\.last_at < \? OR \(r\.last_at = \? AND \(r\."position", r\.id\) > \(\?::double precision, \?\)\) OR r\.last_at IS NULL\)/,
    );
    expect(text).toMatch(/ORDER BY r\.last_at DESC NULLS LAST, r\."position" ASC, r\.id ASC\s+LIMIT \?/);
    // Última interação: coluna do contato; `conversations` só com a coluna NULL.
    expect(text).toContain('COALESCE(ct."lastMessageAt", fb.last_at) AS last_at');
    expect(text).toMatch(/WHERE ct\.id IS NOT NULL\s+AND ct\."lastMessageAt" IS NULL/);
    expect(text).not.toContain('MAX(cv."updatedAt")');
    expect(withLast.values).toEqual([ORG, "s1", "OPEN", 2500, ORG, ORG, at(7), at(7), 2, "d-x", 11]);
    expect(text).not.toContain("d-x");

    const asc = buildLastInteractionColumnPageSql({
      ...base,
      direction: "asc",
      cursor: { sort: "lastInteraction", direction: "asc", position: 2, id: "d-x", lastAt: at(7) },
    });
    expect(asc.strings.join("?")).toMatch(/\(r\.last_at > \? OR/);
    expect(asc.strings.join("?")).toMatch(/ORDER BY r\.last_at ASC NULLS LAST/);

    const nullCursor = buildLastInteractionColumnPageSql({
      ...base,
      direction: "desc",
      cursor: { sort: "lastInteraction", direction: "desc", position: 3, id: "d-y", lastAt: null },
    });
    expect(nullCursor.strings.join("?")).toMatch(
      /WHERE \(r\.last_at IS NULL AND \(r\."position", r\.id\) > \(\?::double precision, \?\)\)/,
    );
    expect(nullCursor.values).toEqual([ORG, "s1", "OPEN", 2500, ORG, ORG, 3, "d-y", 11]);
  });

  it("where que o SQL não traduz: board sai sem cursor (cliente usa offsetByStage) e a rota de página recusa", async () => {
    // Filtro de conversa: o tradutor não cobre (tags e origem do contato
    // viram EXISTS). O board resolve os ids numa consulta e ranqueia em SQL,
    // mas sem cursor — a rota de página só aceita where traduzível.
    const visibility: Prisma.DealWhereInput = {
      contact: { is: { conversations: { some: { status: "OPEN" } } } },
    } as Prisma.DealWhereInput;
    // fake-db não conhece `contact` aqui: o filtro é retirado em memória.
    h.dealFindMany.mockImplementation(async (args: Record<string, unknown>) => {
      const where = JSON.parse(JSON.stringify(args.where ?? {}), (k, v) => (k === "contact" ? undefined : v));
      const rows = db.run("deal", "findMany", { ...args, where }) as Record<string, unknown>[];
      return args.include
        ? rows.map((r) => ({ ...r, contact: null, owner: null, tags: [], activities: [] }))
        : rows;
    });
    h.dealGroupBy.mockImplementation(async () => [{ stageId: "s1", _count: { _all: 12 } }]);
    h.queryRaw.mockImplementation(async (...call: unknown[]) => {
      const { text } = parseRawCall(call);
      if (text.includes("FROM contacts ct")) return [];
      return emulateRaw(call);
    });
    const board = await loadBoard(2, { sortField: "lastInteraction", sortDirection: "desc" }, visibility);
    const s1 = board.find((s) => s.id === "s1")!;
    expect(s1.hasMore).toBe(true);
    expect(s1.nextCursor).toBeNull();

    const cursor = encodeBoardColumnCursor({
      sort: "lastInteraction",
      direction: "desc",
      position: 1,
      id: "d-a",
      lastAt: null,
    });
    await expect(
      withOrg(() =>
        getBoardColumnPages(PIPELINE, visibility, undefined, undefined, {
          sortField: "lastInteraction",
          sortDirection: "desc",
          columns: [{ stageId: "s1", cursor }],
        }),
      ),
    ).rejects.toMatchObject({ code: "cursor_unsupported" });
  });
});
