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
 *   - total de consultas e as fases do `Server-Timing`;
 *   - linhas que o "banco" devolve ao Node (`pgRows`, K6): o tamanho do
 *     resultado de cada consulta; no `include` do Prisma conta também as
 *     linhas das relações (contato, dono, tags, atividades), que o motor
 *     busca em consultas próprias.
 * Estimativa de produção = CPU + `dbDepth` × (15 a 50 ms, o tempo de
 * consulta medido pelo dono).
 *
 * Cenários: POST 200/etapa sem filtro (erro e acerto), com filtro de tag e
 * de origem do contato; GET 10/etapa (Kanban); e, para o K6, a carga padrão
 * (sem `perStage`), a ordenação por última interação e o filtro "Mensagem
 * recebida".
 *
 * Cada contato tem uma conversa (1 em 10 não tem nenhuma), 1 em 4 com não
 * lidas, e pelo menos 5 mensagens do cliente e 1 nossa.
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
    /** Backfill de `contacts.lastMessageAt` em andamento (a sonda de prontidão diz "pendente"). */
    contactsPending: false,
    /** Ids pedidos em cada `deal.findMany` com include (hidratação dos cards). */
    includeIds: [] as string[][],
    /** Linhas devolvidas pelo "banco" na requisição corrente. */
    rows: 0,
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
  contact: {
    conversations: { kind: "many", table: "conversation", foreignKey: "contactId" },
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
const hasConversation = (n: number) => n % 10 !== 9;
const directionOf = (n: number) => (n % 3 === 0 ? "in" : "out");
/** Espalha a última mensagem para a ordem não coincidir com a posição. */
const lastMessageMinute = (n: number) => (n * 7919) % 10_007;
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
      // K1: última mensagem de chat do contato, em coluna pronta. 1 em 10 não
      // tem conversa nenhuma (lead importado) → NULL.
      lastMessageAt: hasConversation(n) ? new Date(T0 + lastMessageMinute(n) * 60_000) : null,
      lastMessageDirection: hasConversation(n) ? directionOf(n) : null,
    });
    if (hasConversation(n)) {
      db.insert("conversation", {
        id: `v${n}`,
        organizationId: ORG,
        contactId,
        channel: "whatsapp",
        unreadCount: n % 4 === 0 ? 2 : 0,
        status: n % 5 === 0 ? "RESOLVED" : "OPEN",
        lastMessageDirection: directionOf(n),
        lastMessageAt: new Date(T0 + lastMessageMinute(n) * 60_000),
        // Gravações que não são mensagem (atribuição, varredura) mexem aqui.
        updatedAt: new Date(T0 + (lastMessageMinute(n) + (n % 7) * 13) * 60_000),
      });
    }
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
const conversationByContact = new Map(
  db.table("conversation").map((v) => [v.contactId as string, v]),
);
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
  if (key === "conversations") {
    const conv = conversationByContact.get(row.id as string);
    return conv ? [conv] : [];
  }
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

/** Soma as linhas devolvidas e repassa o resultado. */
function counted<T extends unknown[]>(rows: T): T {
  h.rows += rows.length;
  return rows;
}

function dealsByStage(): Map<string, Row[]> {
  const byStage = new Map<string, Row[]>();
  for (const d of matchingDeals()) {
    const list = byStage.get(d.stageId as string) ?? [];
    list.push(d);
    byStage.set(d.stageId as string, list);
  }
  return byStage;
}

/** Última interação do card: coluna do contato (K1). */
function lastAtOfDeal(d: Row): number | null {
  const at = contactById.get(d.contactId as string)?.lastMessageAt as Date | null | undefined;
  return at ? at.getTime() : null;
}

function previewRowsFor(contactId: string): Row[] {
  const conv = conversationByContact.get(contactId);
  if (!conv) return [];
  const unread = conv.unreadCount as number;
  const base = { contactId, channel: conv.channel, unreadCount: unread };
  const rows: Row[] = [];
  // Cliente: até 5 quando há não lidas; só a última quando não há (K2).
  for (let rn = 1; rn <= (unread > 0 ? 5 : 1); rn++) {
    rows.push({
      ...base,
      msgId: `m-${contactId}-in-${rn}`,
      msgExternalId: `wamid.${contactId}.${rn}`,
      msgContent: `${TEXT} (${rn})`,
      msgCreatedAt: new Date(T0 + (10 - rn) * 1000),
      msgDirection: "in",
      msgSendStatus: null,
      msgSendError: null,
      rn,
    });
  }
  rows.push({
    ...base,
    msgId: `m-${contactId}-out`,
    msgExternalId: null,
    msgContent: "Claro! Te envio as informações agora.",
    msgCreatedAt: new Date(T0),
    msgDirection: "out",
    msgSendStatus: "sent",
    msgSendError: null,
    rn: 1,
  });
  return rows;
}

async function queryRaw(...call: unknown[]): Promise<unknown> {
  const text = rawText(call);
  const ranked = text.includes('PARTITION BY d."stageId"');
  await pgDelay(ranked ? "raw:ranked" : "raw:other");
  return counted(emulateRaw(text, rawValues(call)) as unknown[]);
}

function emulateRaw(text: string, values: unknown[]): Row[] {
  // Ordenação por última interação: candidatos por etapa, `last_at` do
  // contato, janela final. values = […, scanCap, maxPerStage].
  if (text.includes("WITH candidates AS")) {
    const max = values[values.length - 1] as number;
    const desc = /last_at DESC NULLS LAST/.test(text);
    const out: Row[] = [];
    for (const [stageId, list] of dealsByStage()) {
      const sorted = [...list].sort((a, b) => {
        const la = lastAtOfDeal(a);
        const lb = lastAtOfDeal(b);
        if (la != null && lb != null && la !== lb) return desc ? lb - la : la - lb;
        if (la != null && lb == null) return -1;
        if (la == null && lb != null) return 1;
        return (a.position as number) - (b.position as number);
      });
      sorted.slice(0, max).forEach((d, i) => {
        const la = lastAtOfDeal(d);
        out.push({
          id: d.id,
          stageId,
          rn: i + 1,
          last_at: la == null ? null : new Date(la),
          total: list.length,
        });
      });
    }
    return out;
  }
  if (text.includes('PARTITION BY d."stageId"')) {
    const max = values.find((v) => typeof v === "number") as number;
    const out: Row[] = [];
    for (const [stageId, list] of dealsByStage()) {
      list
        .slice(0, max)
        .forEach((d, i) => out.push({ id: d.id, stageId, rn: i + 1, total: list.length }));
    }
    return out;
  }
  if (text.includes("FROM deal_products")) return [];
  // Organização já com `contacts.lastMessageDirection` preenchida.
  if (text.includes("AS pending")) return [{ pending: h.contactsPending }];
  // Contatos "só com conversas encerradas" do caminho antigo da direção: nenhum na fixture.
  if (text.includes("JOIN LATERAL") && text.includes("last.d")) return [];
  if (text.includes("per_contact AS")) {
    // Prévia do card numa consulta: não lidas/canal repetidos em cada linha.
    return (values[0] as string[]).flatMap(previewRowsFor);
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
        return counted(
          db.run("stage", "findMany", { where: args.where, orderBy: { position: "asc" } }) as Row[],
        );
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
        if (!args.include) return counted(rows);
        h.includeIds.push(rows.map((r) => r.id as string));
        const cards = rows.map(withInclude);
        // O motor do Prisma busca cada relação numa consulta própria: negócios,
        // contatos, donos, tags_on_deals, tags e atividades.
        const distinct = (key: string) => new Set(rows.map((r) => r[key]).filter(Boolean)).size;
        const tagLinks = rows.reduce((n, r) => n + (tagsByDeal.get(r.id as string)?.length ?? 0), 0);
        h.rows +=
          rows.length + distinct("contactId") + distinct("ownerId") + tagLinks + TAGS.length + rows.length;
        return cards;
      },
      groupBy: async (args: { where?: Row }) => {
        await pgDelay("deal.groupBy");
        const counts = new Map<string, number>();
        for (const d of db.table("deal")) {
          if (!db.matches("deal", d, args.where)) continue;
          counts.set(d.stageId as string, (counts.get(d.stageId as string) ?? 0) + 1);
        }
        return counted([...counts].map(([stageId, n]) => ({ stageId, _count: { _all: n } })));
      },
    },
  },
}));

import { GET, POST } from "@/app/api/pipelines/[id]/board/route";
import { resetContactLastMessageReadyForTests } from "@/services/kanban-filters";

type Measure = {
  scenario: string;
  medianMs: number;
  minMs: number;
  pgCalls: number;
  /** Idas ao banco contando os níveis do include (ver `pgDelay`). */
  pgTrips: number;
  /** Idas ao banco EM SÉRIE (ver `pgDelay`). */
  dbDepth: number;
  /** Linhas devolvidas pelo banco ao Node na requisição. */
  pgRows: number;
  /** CPU do processo (user + system) por requisição, média das rodadas. */
  cpuMs: number;
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
    rows: number;
  } | null = null;
  let cpuMicros = 0;
  for (let i = 0; i < RUNS; i++) {
    if (!opts.warm) h.redis.store.clear();
    else if (i === 0) {
      h.redis.store.clear();
      await (await send()).text(); // aquece o cache
    }
    h.pg.length = 0;
    h.trips = 0;
    h.doneDepth = 0;
    h.rows = 0;
    const cpu0 = process.cpuUsage();
    const t = performance.now();
    const res = await send();
    const text = await res.text();
    times.push(performance.now() - t);
    const cpu = process.cpuUsage(cpu0);
    cpuMicros += cpu.user + cpu.system;
    last = { res, text, pg: [...h.pg], trips: h.trips, depth: h.doneDepth, rows: h.rows };
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
    pgRows: last!.rows,
    cpuMs: Math.round((cpuMicros / RUNS / 1000) * 10) / 10,
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

  // ── K6: página padrão, última interação e filtro de direção ──────────

  it("POST padrão (sem perStage) — erro de cache: 50 por etapa", async () => {
    const m = await measure("POST padrão, sem perStage (miss)", OPEN, () =>
      POST(postReq({}), params()), { warm: false });
    expect(m.cards).toBe(STAGE_COUNT * 50);
    // etapas + janela (com os totais) + hidratação + produtos + prévia + avatar
    expect(m.pgLabels).toEqual({
      "stage.findMany": 1,
      "raw:ranked": 1,
      "deal.findMany(include)": 1,
      "raw:other": 2,
      "user.findMany(avatar)": 1,
    });
  }, 60_000);

  it("POST 200/etapa por última interação — erro de cache", async () => {
    const m = await measure("POST 200/etapa lastInteraction desc (miss)", OPEN, () =>
      POST(postReq({ perStage: PER_STAGE, sort: "lastInteraction", direction: "desc" }), params()), {
      warm: false,
    });
    expect(m.cards).toBe(STAGE_COUNT * PER_STAGE);
    expect(m.pgLabels["deal.groupBy"]).toBeUndefined();
    expect(m.pgLabels["deal.findMany(select)"]).toBeUndefined();
  }, 60_000);

  it("POST 200/etapa com filtro 'Mensagem recebida' — erro de cache", async () => {
    const where = { AND: [OPEN, { contact: { is: { lastMessageDirection: "in" } } }] };
    const m = await measure("POST direção=in 200/etapa (miss)", where, () =>
      POST(postReq({ perStage: PER_STAGE, filters: { lastMessageDirection: "in" } }), params()), {
      warm: false,
    });
    expect(m.cards).toBeGreaterThan(0);
    // Predicado no contato: traduz para SQL — sem pré-resolver ids, sem
    // contagem à parte.
    expect(m.pgLabels["deal.findMany(select)"]).toBeUndefined();
    expect(m.pgLabels["deal.groupBy"]).toBeUndefined();
  }, 60_000);

  it("POST 200/etapa com filtro 'Mensagem recebida' e backfill em andamento — erro de cache (L8)", async () => {
    // Org com contatos por preencher: coluna onde existe + caminho antigo só
    // para a coluna NULL. Antes (tudo-ou-nada) o where saía do tradutor e o
    // board pré-resolvia ids numa consulta à parte.
    resetContactLastMessageReadyForTests();
    h.contactsPending = true;
    try {
      const where = {
        AND: [
          OPEN,
          {
            OR: [
              { contact: { is: { lastMessageDirection: "in" } } },
              {
                contact: {
                  is: {
                    AND: [
                      { lastMessageAt: null },
                      {
                        conversations: {
                          some: { status: { not: "RESOLVED" }, lastMessageDirection: "in" },
                        },
                      },
                      {
                        conversations: {
                          none: { status: { not: "RESOLVED" }, lastMessageDirection: "out" },
                        },
                      },
                    ],
                  },
                },
              },
              { contactId: { in: [] } },
            ],
          },
        ],
      };
      const m = await measure("POST direção=in 200/etapa, backfill em andamento (miss)", where, () =>
        POST(postReq({ perStage: PER_STAGE, filters: { lastMessageDirection: "in" } }), params()), {
        warm: false,
      });
      expect(m.cards).toBeGreaterThan(0);
      // Tudo na consulta ranqueada: sem pré-resolver ids, sem contagem à parte.
      expect(m.pgLabels["deal.findMany(select)"]).toBeUndefined();
      expect(m.pgLabels["deal.groupBy"]).toBeUndefined();
      expect(m.pgLabels["raw:ranked"]).toBe(1);
      // Etapas + janela + hidratação + produtos + prévia + avatar + a lista dos
      // "só encerradas" (a sonda fica em memória por 1 min).
      expect(m.pgCalls).toBe(7);
    } finally {
      h.contactsPending = false;
      resetContactLastMessageReadyForTests();
    }
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

  // ── Tamanho da página (K4) ──────────────────────────────────────────────

  type StageBody = {
    id: string;
    deals: { id: string }[];
    totalCount: number;
    loadedCount: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  const boardOf = async (res: Response) => JSON.parse(await res.text()) as StageBody[];
  const getBoard = (query: string) =>
    GET(new Request(`http://localhost/api/pipelines/${PIPELINE}/board${query}`), params());

  it("sem perStage/limit: 50 cards por etapa, com total, hasMore e cursor para o resto", async () => {
    const board = await boardOf(await getBoard(""));
    expect(board).toHaveLength(STAGE_COUNT);
    for (const stage of board) {
      expect(stage.deals).toHaveLength(50);
      expect(stage.loadedCount).toBe(50);
      expect(stage.totalCount).toBe(PER_STAGE + 20);
      expect(stage.hasMore).toBe(true);
      expect(typeof stage.nextCursor).toBe("string");
    }
  });

  it("`limit` vale como `perStage` (GET e POST) e cai na mesma chave de cache", async () => {
    const viaLimit = await getBoard("?limit=30");
    expect(cacheDesc(viaLimit)).toBe("miss");
    const board = await boardOf(viaLimit);
    expect(board.every((s) => s.deals.length === 30)).toBe(true);

    const viaPerStage = await getBoard("?perStage=30");
    expect(cacheDesc(viaPerStage)).toBe("hit");
    const viaPostLimit = await POST(postReq({ limit: 30 }), params());
    expect(cacheDesc(viaPostLimit)).toBe("hit");
    // Os dois informados: `perStage` (nome histórico) vence.
    const both = await boardOf(await getBoard("?perStage=10&limit=30"));
    expect(both.every((s) => s.deals.length === 10)).toBe(true);
  });

  it("o frontend atual pede 200 e recebe 200; acima do teto vem o teto (200), nunca 500", async () => {
    const at200 = await boardOf(await POST(postReq({ perStage: 200 }), params()));
    expect(at200.every((s) => s.deals.length === 200 && s.hasMore === true)).toBe(true);

    h.pg.length = 0;
    const over = await POST(postReq({ perStage: 500 }), params());
    // Mesmo resultado do pedido de 200 → mesma chave, nenhuma consulta.
    expect(cacheDesc(over)).toBe("hit");
    expect(h.pg).toEqual([]);
    expect((await boardOf(over)).every((s) => s.deals.length === 200)).toBe(true);
  });

  it("valor inválido cai no padrão (50); zero/negativo vira 1", async () => {
    expect((await boardOf(await getBoard("?perStage=abc"))).every((s) => s.deals.length === 50)).toBe(true);
    expect((await boardOf(await getBoard("?limit=0"))).every((s) => s.deals.length === 1)).toBe(true);
    expect(
      (await boardOf(await POST(postReq({ perStage: "200" }), params()))).every((s) => s.deals.length === 50),
    ).toBe(true);
  });

  it("offsetByStage antigo continua aceito: perStage + extra só na etapa pedida", async () => {
    const board = await boardOf(
      await POST(postReq({ perStage: 10, offsetByStage: { st0: 15, st1: -3, st2: 0 } }), params()),
    );
    const sizes = Object.fromEntries(board.map((s) => [s.id, s.deals.length]));
    expect(sizes.st0).toBe(25);
    expect(sizes.st1).toBe(10);
    expect(sizes.st2).toBe(10);
  });

  it("hidrata só os cards devolvidos (ids da página, não a coluna inteira)", async () => {
    h.includeIds.length = 0;
    const board = await boardOf(await getBoard("?limit=20"));
    const returned = board.flatMap((s) => s.deals.map((d) => d.id)).sort();
    expect(returned).toHaveLength(STAGE_COUNT * 20);
    expect(h.includeIds).toHaveLength(1);
    expect([...h.includeIds[0]!].sort()).toEqual(returned);
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
