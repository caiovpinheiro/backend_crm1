/**
 * Board grande SINTÉTICO (B3): 7 etapas × 200 cards, banco em memória e
 * Redis falso em memória, pela rota de verdade (GET/POST).
 *
 * Mede separadamente:
 *   - CPU do processo: o "banco" responde na hora (sem timer — o timer do
 *     Windows tem resolução de ~15 ms e sujava a medida), então o tempo de
 *     parede é o custo de montar, serializar, gzip/gunzip e copiar;
 *   - idas ao banco em série (`dbDepth`): profundidade do encadeamento das
 *     consultas, como em `io-probe.ts`; o `include` do Prisma sem
 *     `relationJoins` conta 3 níveis (deals → relações → tag);
 *   - total de consultas e as fases do `Server-Timing`.
 * Estimativa de produção = CPU + `dbDepth` × (15 a 50 ms, o tempo de
 * consulta medido pelo dono).
 *
 * Cenários: POST 200/etapa sem filtro (erro e acerto), com filtro de tag e
 * de origem do contato; GET 10/etapa (Kanban).
 *
 * NÃO é produção: sem rede, sem compressão HTTP, sem motor do Prisma. Serve
 * para comparar antes × depois no mesmo ambiente. Com
 * `BOARD_BENCH_OUT=<arquivo>` os números vão para um JSON (o teste não
 * imprime nada).
 */
import { writeFileSync } from "node:fs";

import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDb, type FakeDbSchema } from "@/test-setup/fake-db";

const STAGE_COUNT = 7;
const PER_STAGE = 200;
const RUNS = 9;

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
    pg: [] as string[],
    trips: 0,
    /** Maior profundidade já concluída na requisição corrente. */
    doneDepth: 0,
    /** Papel do usuário nos testes de contrato (ADMIN que vê tudo por padrão). */
    authz: {
      isAdmin: true,
      stageDeny: [] as string[],
      pipelineDenied: false,
      ownOnly: false,
    },
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/auth-helpers", async () => {
  const { runWithContext } = await import("@/lib/request-context");
  return {
    withOrgContext: async (handler: (s: unknown) => unknown) => {
      const session = {
        user: {
          id: "u-admin",
          role: "ADMIN",
          organizationId: "org-bench",
          isSuperAdmin: false,
          name: "Admin",
        },
      };
      return runWithContext(
        {
          organizationId: "org-bench",
          userId: "u-admin",
          isSuperAdmin: false,
          actor: { type: "HUMAN", label: "Admin" },
        } as never,
        () => handler(session),
      );
    },
  };
});
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  loadAuthzContext: vi.fn(async () => ({
    userId: "u-admin",
    organizationId: "org-bench",
    isSuperAdmin: false,
    isAdmin: h.authz.isAdmin,
    permissions: new Set(["*"]),
    stageView: null,
    stageDeny: new Set(h.authz.stageDeny),
    stageEdit: null,
    pipelineDeny: new Set(),
  })),
}));
vi.mock("@/lib/authz/resource-policy", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requirePipelineScope: vi.fn(async () =>
      h.authz.pipelineDenied
        ? NextResponse.json({ message: "Acesso negado ao funil." }, { status: 403 })
        : null,
    ),
  };
});
vi.mock("@/lib/visibility", () => ({
  getVisibilityFilter: vi.fn(async () => ({
    dealWhere: h.authz.ownOnly ? { ownerId: "u0" } : {},
    conversationWhere: {},
    canSeeAll: !h.authz.ownOnly,
    includeUnassigned: true,
  })),
}));
vi.mock("@/services/pipelines", () => ({
  resolvePipelineByPublicRef: vi.fn(async (ref: string) => ({ id: ref, name: "Funil" })),
  getPipelineMeta: vi.fn(async (id: string) => ({ id, name: "Funil" })),
}));
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
  // Cache de 300 s em produção: quase sempre de graça.
  getStageMetrics: vi.fn(async () => []),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async () => {
    await pgDelay("user.findMany(avatar)");
  }),
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));

/**
 * Uma ida ao "Postgres", sem latência. A profundidade em série é a de
 * `io-probe.ts`: 1 + a maior profundidade entre as consultas que já tinham
 * terminado quando esta começou. `trips` > 1 modela o `include` do Prisma
 * sem `relationJoins` (o motor lê nível por nível: deals → contato/dono/
 * tags/atividades → tag).
 */
async function pgDelay(label: string, trips = 1): Promise<void> {
  h.pg.push(label);
  h.trips += trips;
  const depth = h.doneDepth + trips;
  await new Promise((r) => setImmediate(r));
  h.doneDepth = Math.max(h.doneDepth, depth);
}

// ── Dados sintéticos ────────────────────────────────────────────────────

const ORG = "org-bench";
const PIPELINE = "pipe-bench";
const T0 = Date.UTC(2026, 9, 1);
const TEXT =
  "Olá, gostaria de saber mais sobre o curso de pós-graduação e as formas de pagamento disponíveis";

const SCHEMA: FakeDbSchema = {
  deal: {
    tags: { kind: "many", table: "tagOnDeal", foreignKey: "dealId" },
    contact: { kind: "one", table: "contact", localKey: "contactId" },
    stage: { kind: "one", table: "stage", localKey: "stageId" },
  },
};
const db = new FakeDb(SCHEMA);
const STAGES = Array.from({ length: STAGE_COUNT }, (_, i) => ({
  id: `st${i}`,
  organizationId: ORG,
  pipelineId: PIPELINE,
  name: `Etapa ${i}`,
  slug: `etapa-${i}`,
  number: i + 1,
  position: i,
  color: "#3366ff",
  winProbability: 10,
  rottingDays: 30,
  isIncoming: i === 0,
  isWon: false,
  isLost: false,
  requiredDealFieldIds: [],
}));
db.insert("stage", ...STAGES);
const USERS = Array.from({ length: 5 }, (_, i) => ({
  id: `u${i}`,
  name: `Usuário ${i}`,
  avatarUrl: null,
  type: "HUMAN",
}));
const TAGS = Array.from({ length: 6 }, (_, i) => ({
  id: `tag${i}`,
  name: `Tag ${i}`,
  color: "#aa0000",
}));
for (const st of STAGES) {
  for (let p = 0; p < PER_STAGE + 20; p++) {
    const n = Number(st.id.slice(2)) * 1000 + p;
    const contactId = `c${n}`;
    db.insert("contact", {
      id: contactId,
      organizationId: ORG,
      name: `Contato ${n}`,
      email: `c${n}@exemplo.com`,
      phone: `55119${String(n).padStart(8, "0")}`,
      avatarUrl: null,
      source: n % 3 === 0 ? "facebook" : "site",
      adUtmSource: null,
    });
    db.insert("deal", {
      id: `d${n}`,
      organizationId: ORG,
      number: n,
      title: `Negócio ${n}`,
      value: 1500,
      status: "OPEN",
      stageId: st.id,
      position: p,
      ownerId: `u${n % 5}`,
      contactId,
      orgUnitId: null,
      lostReason: null,
      dealRole: "COMMERCIAL",
      assignedVia: null,
      externalId: null,
      expectedClose: null,
      closedAt: null,
      createdAt: new Date(T0 + n * 60_000),
      updatedAt: new Date(T0 + n * 90_000),
    });
    db.insert("tagOnDeal", { dealId: `d${n}`, tagId: `tag${n % 6}` });
    db.insert("tagOnDeal", { dealId: `d${n}`, tagId: `tag${(n + 1) % 6}` });
  }
}

type Row = Record<string, unknown>;

// Índices das relações: a busca linear do FakeDb (O(n) por linha) custaria
// mais CPU que o próprio board e sujaria a medição.
const byId = (table: string) => new Map(db.table(table).map((r) => [r.id as string, r]));
const contactById = byId("contact");
const stageById = byId("stage");
const tagsByDeal = new Map<string, Row[]>();
for (const t of db.table("tagOnDeal")) {
  const list = tagsByDeal.get(t.dealId as string) ?? [];
  list.push(t);
  tagsByDeal.set(t.dealId as string, list);
}
(db as unknown as { related: (m: string, row: Row, key: string) => unknown }).related = (
  _model,
  row,
  key,
) => {
  if (key === "tags") return tagsByDeal.get(row.id as string) ?? [];
  if (key === "contact") return row.contactId ? contactById.get(row.contactId as string) ?? null : null;
  if (key === "stage") return stageById.get(row.stageId as string) ?? null;
  return undefined;
};

function withInclude(deal: Row): Row {
  return {
    ...deal,
    contact: contactById.get(deal.contactId as string) ?? null,
    owner: USERS.find((u) => u.id === deal.ownerId) ?? null,
    tags: (tagsByDeal.get(deal.id as string) ?? []).map((t) => ({
      tag: TAGS.find((g) => g.id === t.tagId),
    })),
    activities: [{ id: `a-${deal.id}`, scheduledAt: new Date(T0 + 86_400_000) }],
  };
}

/** Where Prisma do cenário corrente (as consultas cruas filtram por ele). */
let scenarioWhere: Row = {};

function matchingDeals(): Row[] {
  return db
    .table("deal")
    .filter((d) => db.matches("deal", d, scenarioWhere))
    .sort((a, b) => (a.position as number) - (b.position as number));
}

function rawText(call: unknown[]): string {
  const [first] = call;
  if (Array.isArray(first)) return (first as readonly string[]).join("?");
  return (first as Prisma.Sql).strings.join("?");
}

function rawValues(call: unknown[]): unknown[] {
  const [first, ...rest] = call;
  if (Array.isArray(first)) return rest;
  return (first as Prisma.Sql).values;
}

async function queryRaw(...call: unknown[]): Promise<unknown> {
  const text = rawText(call);
  await pgDelay(text.includes('PARTITION BY d."stageId"') ? "raw:ranked" : "raw:other");
  if (text.includes('PARTITION BY d."stageId"')) {
    const values = rawValues(call);
    const max = values.find((v) => typeof v === "number") as number;
    const byStage = new Map<string, Row[]>();
    for (const d of matchingDeals()) {
      const list = byStage.get(d.stageId as string) ?? [];
      list.push(d);
      byStage.set(d.stageId as string, list);
    }
    const out: Row[] = [];
    for (const [stageId, list] of byStage) {
      list.slice(0, max).forEach((d, i) => out.push({ id: d.id, stageId, rn: i + 1 }));
    }
    return out;
  }
  if (text.includes("FROM deal_products")) return [];
  if (text.includes("contact_unread")) {
    const ids = rawValues(call)[0] as string[];
    return ids.map((contactId) => ({ contactId, channel: "whatsapp", unreadCount: 2 }));
  }
  if (text.includes('PARTITION BY c."contactId", m.direction')) {
    const ids = rawValues(call)[0] as string[];
    const rows: Row[] = [];
    for (const contactId of ids) {
      for (let rn = 1; rn <= 5; rn++) {
        rows.push({
          contactId,
          msgId: `m-${contactId}-in-${rn}`,
          msgExternalId: `wamid.${contactId}.${rn}`,
          msgContent: `${TEXT} (${rn})`,
          msgCreatedAt: new Date(T0 + rn * 1000),
          msgDirection: "in",
          msgSendStatus: null,
          msgSendError: null,
          rn,
        });
      }
      rows.push({
        contactId,
        msgId: `m-${contactId}-out`,
        msgExternalId: null,
        msgContent: "Claro! Te envio as informações agora.",
        msgCreatedAt: new Date(T0),
        msgDirection: "out",
        msgSendStatus: "sent",
        msgSendError: null,
        rn: 1,
      });
    }
    return rows;
  }
  return [];
}

vi.mock("@/lib/prisma", () => ({
  allocateOrgNumber: vi.fn(),
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    stage: {
      findMany: async (args: { where?: Row }) => {
        await pgDelay("stage.findMany");
        return db.run("stage", "findMany", { where: args.where, orderBy: { position: "asc" } });
      },
    },
    customField: {
      findMany: async () => {
        await pgDelay("customField.findMany");
        return [];
      },
    },
    deal: {
      findMany: async (args: { where?: Row; take?: number; select?: Row; include?: Row; orderBy?: unknown }) => {
        await pgDelay(
          args.include ? "deal.findMany(include)" : "deal.findMany(select)",
          args.include ? 3 : 1,
        );
        const rows = db.run("deal", "findMany", {
          where: args.where,
          orderBy: args.orderBy ?? [{ position: "asc" }],
          take: args.take,
          select: args.select,
        }) as Row[];
        return args.include ? rows.map(withInclude) : rows;
      },
      groupBy: async (args: { where?: Row }) => {
        await pgDelay("deal.groupBy");
        const counts = new Map<string, number>();
        for (const d of db.table("deal")) {
          if (!db.matches("deal", d, args.where)) continue;
          counts.set(d.stageId as string, (counts.get(d.stageId as string) ?? 0) + 1);
        }
        return [...counts].map(([stageId, n]) => ({ stageId, _count: { _all: n } }));
      },
    },
  },
}));

import { GET, POST } from "@/app/api/pipelines/[id]/board/route";

type Measure = {
  scenario: string;
  medianMs: number;
  minMs: number;
  pgCalls: number;
  /** Idas ao banco contando os níveis do include (ver `pgDelay`). */
  pgTrips: number;
  /** Idas ao banco EM SÉRIE (ver `pgDelay`). */
  dbDepth: number;
  pgLabels: Record<string, number>;
  bytes: number;
  cards: number;
  serverTiming: string | null;
};

const results: Measure[] = [];

function params() {
  return { params: Promise.resolve({ id: PIPELINE }) };
}

function postReq(body: unknown) {
  return new Request(`http://localhost/api/pipelines/${PIPELINE}/board`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function measure(
  scenario: string,
  where: Row,
  send: () => Promise<Response>,
  opts: { warm: boolean },
): Promise<Measure> {
  scenarioWhere = where;
  const times: number[] = [];
  let last: {
    res: Response;
    text: string;
    pg: string[];
    trips: number;
    depth: number;
  } | null = null;
  for (let i = 0; i < RUNS; i++) {
    if (!opts.warm) h.redis.store.clear();
    else if (i === 0) {
      h.redis.store.clear();
      await (await send()).text(); // aquece o cache
    }
    h.pg.length = 0;
    h.trips = 0;
    h.doneDepth = 0;
    const t = performance.now();
    const res = await send();
    const text = await res.text();
    times.push(performance.now() - t);
    last = { res, text, pg: [...h.pg], trips: h.trips, depth: h.doneDepth };
  }
  times.sort((a, b) => a - b);
  const body = JSON.parse(last!.text) as Array<{ deals: unknown[] }>;
  const labels: Record<string, number> = {};
  for (const l of last!.pg) labels[l] = (labels[l] ?? 0) + 1;
  const m: Measure = {
    scenario,
    medianMs: Math.round(times[Math.floor(times.length / 2)]!),
    minMs: Math.round(times[0]!),
    pgCalls: last!.pg.length,
    pgTrips: last!.trips,
    dbDepth: last!.depth,
    pgLabels: labels,
    bytes: Buffer.byteLength(last!.text),
    cards: body.reduce((n, s) => n + s.deals.length, 0),
    serverTiming: last!.res.headers.get("server-timing"),
  };
  results.push(m);
  return m;
}

const OPEN = { status: "OPEN" };

describe("board sintético 7×200 (benchmark local)", () => {
  beforeEach(() => {
    h.redis.store.clear();
  });
  afterAll(() => {
    const out = process.env.BOARD_BENCH_OUT;
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  });

  it("POST sem filtro, 200/etapa — erro de cache", async () => {
    const m = await measure("POST 200/etapa sem filtro (miss)", OPEN, () =>
      POST(postReq({ perStage: PER_STAGE }), params()), { warm: false });
    expect(m.cards).toBe(STAGE_COUNT * PER_STAGE);
  }, 60_000);

  it("POST sem filtro, 200/etapa — acerto de cache", async () => {
    const m = await measure("POST 200/etapa sem filtro (hit)", OPEN, () =>
      POST(postReq({ perStage: PER_STAGE }), params()), { warm: true });
    expect(m.cards).toBe(STAGE_COUNT * PER_STAGE);
    expect(m.pgCalls).toBe(0);
  }, 60_000);

  it("POST com filtro de tag, 200/etapa — erro de cache", async () => {
    const where = { AND: [OPEN, { tags: { some: { tagId: { in: ["tag1"] } } } }] };
    const m = await measure("POST tag (miss)", where, () =>
      POST(postReq({ perStage: PER_STAGE, filters: { tagIds: ["tag1"] } }), params()), {
      warm: false,
    });
    expect(m.cards).toBeGreaterThan(0);
  }, 60_000);

  it("POST com filtro de origem do contato, 200/etapa — erro de cache", async () => {
    const where = { AND: [OPEN, { contact: { is: { source: { in: ["facebook"] } } } }] };
    const m = await measure("POST origem (miss)", where, () =>
      POST(postReq({ perStage: PER_STAGE, filters: { sources: ["facebook"] } }), params()), {
      warm: false,
    });
    expect(m.cards).toBeGreaterThan(0);
  }, 60_000);

  it("POST com busca de contato (fora do tradutor), 200/etapa — erro de cache", async () => {
    const where = {
      AND: [
        OPEN,
        { contact: { is: { OR: [{ name: { contains: "Contato 1", mode: "insensitive" } }] } } },
      ],
    };
    const m = await measure("POST busca contato (miss)", where, () =>
      POST(postReq({ perStage: PER_STAGE, filters: { contactSearch: "Contato 1" } }), params()), {
      warm: false,
    });
    expect(m.cards).toBeGreaterThan(0);
  }, 60_000);

  it("POST com filtro de tag — acerto de cache", async () => {
    const where = { AND: [OPEN, { tags: { some: { tagId: { in: ["tag1"] } } } }] };
    const m = await measure("POST tag (hit)", where, () =>
      POST(postReq({ perStage: PER_STAGE, filters: { tagIds: ["tag1"] } }), params()), {
      warm: true,
    });
    expect(m.pgCalls).toBe(0);
  }, 60_000);

  it("GET 10/etapa (Kanban) — erro e acerto", async () => {
    const get = () =>
      GET(new Request(`http://localhost/api/pipelines/${PIPELINE}/board?perStage=10`), params());
    const miss = await measure("GET 10/etapa (miss)", OPEN, get, { warm: false });
    expect(miss.cards).toBe(STAGE_COUNT * 10);
    const hit = await measure("GET 10/etapa (hit)", OPEN, get, { warm: true });
    expect(hit.pgCalls).toBe(0);
  }, 60_000);
});

// ── Contrato da rota (cache canônico + checagens) ───────────────────────

function cacheDesc(res: Response): string | undefined {
  return /cache;dur=[\d.]+;desc="(\w+)"/.exec(res.headers.get("server-timing") ?? "")?.[1];
}

describe("rota do board: cache canônico e checagens", () => {
  beforeEach(() => {
    h.redis.store.clear();
    h.authz.isAdmin = true;
    h.authz.stageDeny = [];
    h.authz.pipelineDenied = false;
    h.authz.ownOnly = false;
    scenarioWhere = OPEN;
  });

  it("POST sem filtro e o GET equivalente dividem a chave; vazio/padrão não muda a chave", async () => {
    const get = await GET(
      new Request(`http://localhost/api/pipelines/${PIPELINE}/board?perStage=30`),
      params(),
    );
    expect(get.status).toBe(200);
    expect(cacheDesc(get)).toBe("miss");
    const getText = await get.text();

    h.pg.length = 0;
    const post = await POST(
      postReq({
        perStage: 30,
        status: "OPEN",
        sort: "position",
        direction: "desc",
        offsetByStage: { st0: 0 },
        filters: { tagIds: [], search: "   ", withoutOwner: false, pipelineId: PIPELINE },
      }),
      params(),
    );
    expect(cacheDesc(post)).toBe("hit");
    expect(h.pg).toEqual([]);
    // Acerto devolve o mesmo texto guardado, sem reserializar.
    expect(await post.text()).toBe(getText);
  });

  it("mesmos filtros em outra ordem caem na mesma chave", async () => {
    scenarioWhere = { AND: [OPEN, { tags: { some: { tagId: { in: ["tag1", "tag2"] } } } }] };
    const a = await POST(
      postReq({ perStage: 20, filters: { tagIds: ["tag2", "tag1"], sources: ["site", "facebook"] } }),
      params(),
    );
    expect(cacheDesc(a)).toBe("miss");
    const b = await POST(
      postReq({ filters: { sources: ["facebook", "site"], tagIds: ["tag1", "tag2"] }, perStage: 20 }),
      params(),
    );
    expect(cacheDesc(b)).toBe("hit");
    // Filtro diferente é outra chave.
    const c = await POST(postReq({ perStage: 20, filters: { tagIds: ["tag1"] } }), params());
    expect(cacheDesc(c)).toBe("miss");
  });

  it("etapa negada pelo papel some da resposta e não divide cache com quem vê tudo", async () => {
    h.authz.isAdmin = false;
    h.authz.stageDeny = ["st1"];
    const limited = await POST(postReq({ perStage: 5 }), params());
    const limitedBody = (await limited.json()) as Array<{ id: string }>;
    expect(limitedBody.map((st) => st.id)).not.toContain("st1");
    expect(limitedBody).toHaveLength(STAGE_COUNT - 1);

    h.authz.isAdmin = true;
    h.authz.stageDeny = [];
    const full = await POST(postReq({ perStage: 5 }), params());
    expect(cacheDesc(full)).toBe("miss");
    const fullBody = (await full.json()) as Array<{ id: string }>;
    expect(fullBody.map((st) => st.id)).toContain("st1");
  });

  it("visibilidade \"só os meus\" entra na chave (não reaproveita o board de quem vê tudo)", async () => {
    await POST(postReq({ perStage: 5 }), params());
    h.authz.ownOnly = true;
    const own = await POST(postReq({ perStage: 5 }), params());
    expect(cacheDesc(own)).toBe("miss");
  });

  it("funil negado: 403 e nenhuma consulta de cards", async () => {
    h.authz.pipelineDenied = true;
    h.pg.length = 0;
    const res = await POST(postReq({ perStage: 5 }), params());
    expect(res.status).toBe(403);
    expect(h.pg).toEqual([]);
  });

  it("Server-Timing traz as fases do erro de cache", async () => {
    const res = await POST(postReq({ perStage: 5 }), params());
    const header = res.headers.get("server-timing") ?? "";
    for (const phase of ["auth", "pre", "filters", "stages", "cards", "enrich", "build", "ser", "cache", "total"]) {
      expect(header).toMatch(new RegExp(`(^|, )${phase};dur=`));
    }
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("filtro fora do tradutor: ids numa consulta, totais sem groupBy", async () => {
    // Campo personalizado de data → `{ id: { in } }` traduz; busca de
    // contato (`contains`) não traduz e cai na pré-resolução.
    scenarioWhere = OPEN;
    h.pg.length = 0;
    const res = await POST(postReq({ perStage: 5, filters: { contactSearch: "Contato 1" } }), params());
    expect(res.status).toBe(200);
    expect(h.pg).toContain("deal.findMany(select)");
    expect(h.pg).not.toContain("deal.groupBy");
    expect(h.pg.filter((l) => l === "deal.findMany(include)")).toHaveLength(1);
  });
});
