/**
 * ETag + 304 do board (gate C): `GET`/`POST /api/pipelines/:id/board` e
 * `POST /api/pipelines/:id/board/columns`.
 *
 * Rota de verdade, Redis falso em memória, "banco" que registra qualquer
 * acesso (`h.db`) e a visibilidade de negócios de verdade
 * (`getDealVisibilityFilter`, settings/authz falsos). O serviço do board é
 * falso e conta as cargas (`h.boardLoads`) — o que está em teste é o caminho
 * até ele: com `If-None-Match` igual, 304 sem corpo, sem carga e sem banco.
 *
 * Cobre: 304 em GET/POST/colunas/etapas; ETag do POST pelo corpo canônico;
 * mensagem NÃO muda o ETag (só com ordenação por última interação);
 * escritores de card mudam; isolamento entre orgs e entre perfis de
 * visibilidade; bump de outra réplica vale em ≤ 5 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    /** Qualquer acesso ao Prisma (scoped ou base). */
    db: [] as string[],
    boardLoads: 0,
    columnLoads: 0,
    session: { id: "u-manager", role: "MANAGER", org: "org-a" },
    /** Settings `visibility.*` / `unassigned.*` da org. */
    settings: new Map<string, string>(),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

function dbProxy(name: string) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        h.db.push(`${name}.${String(prop)}`);
        return new Proxy(() => {}, {
          get: () => () => Promise.reject(new Error(`banco acessado: ${String(prop)}`)),
          apply: () => Promise.reject(new Error(`banco acessado: ${String(prop)}`)),
        });
      },
    },
  );
}
vi.mock("@/lib/prisma", () => ({ prisma: dbProxy("prisma") }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: dbProxy("prismaBase") }));

vi.mock("@/lib/auth-helpers", async () => {
  const { runWithContext } = await import("@/lib/request-context");
  return {
    withOrgContext: async (handler: (s: unknown) => unknown) =>
      runWithContext(
        {
          organizationId: h.session.org,
          userId: h.session.id,
          isSuperAdmin: false,
          actor: { type: "HUMAN", label: "Teste" },
        } as never,
        () =>
          handler({
            user: {
              id: h.session.id,
              role: h.session.role,
              organizationId: h.session.org,
              isSuperAdmin: false,
              name: "Teste",
            },
          }),
      ),
  };
});
function authzCtx() {
  return {
    userId: h.session.id,
    organizationId: h.session.org,
    isSuperAdmin: false,
    isAdmin: false,
    permissions: new Set(["*"]),
    stageView: null,
    stageDeny: new Set<string>(),
    stageEdit: null,
    pipelineDeny: new Set<string>(),
    seeTeam: false,
    seeUnassigned: false,
  };
}
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  loadAuthzContext: vi.fn(async () => authzCtx()),
}));
vi.mock("@/lib/authz/request-prechecks", () => ({
  authzContextOnce: vi.fn(async () => authzCtx()),
  featureEnabledOnce: vi.fn(async () => false),
  scopeGrantsOnce: vi.fn(async () => ({})),
  orgSettingsByPrefixOnce: vi.fn(
    async (_memo: unknown, prefix: string) =>
      new Map([...h.settings].filter(([key]) => key.startsWith(prefix))),
  ),
}));
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePipelineScope: vi.fn(async () => null),
}));
vi.mock("@/services/pipelines", () => ({
  resolvePipelineByPublicRef: vi.fn(async (ref: string) => ({
    id: ref,
    number: 1,
    slug: "funil",
    name: "Funil",
  })),
  getPipelineMeta: vi.fn(async (id: string) => ({ id, name: "Funil" })),
}));
vi.mock("@/services/kanban-filters", () => ({
  parseAdvancedDealFilters: (raw: unknown) =>
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined,
}));
vi.mock("@/services/deals", () => {
  class BoardColumnPageError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    BoardColumnPageError,
    isValidDealStatus: (v: string) => ["OPEN", "WON", "LOST"].includes(v),
    getBoardJson: vi.fn(async () => {
      h.boardLoads += 1;
      return { json: JSON.stringify([{ id: "st1", deals: [{ id: "d1" }] }]), source: "miss" };
    }),
    getBoardColumnPages: vi.fn(async () => {
      h.columnLoads += 1;
      return [{ stageId: "st1", deals: [], totalCount: 0, nextCursor: null, hasMore: false }];
    }),
  };
});

import { GET, POST } from "@/app/api/pipelines/[id]/board/route";
import { POST as POST_COLUMNS } from "@/app/api/pipelines/[id]/board/columns/route";
import { noteBoardCardWrite, resetBoardCardWritesForTests } from "@/lib/board-card-writes";
import { BOARD_ETAG_SAFETY_BUCKET_MS, computeBoardEtag } from "@/lib/cache/board-etag";
import {
  invalidateBoardData,
  invalidateOrgBoards,
  scheduleBoardInvalidationForMessages,
} from "@/lib/cache/keys";
import { resetCoalesceForTests } from "@/lib/cache/coalesce";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import { runWithContext } from "@/lib/request-context";

const PIPE = "cmpipe000000000000000001";
const T0 = Date.UTC(2026, 9, 15, 12, 0, 5);

type Opts = { etag?: string | null; query?: string };

function ctx() {
  return { params: Promise.resolve({ id: PIPE }) };
}

function headers(etag?: string | null): Record<string, string> {
  return etag ? { "If-None-Match": etag } : {};
}

function getBoard(opts: Opts = {}) {
  const url = `http://localhost/api/pipelines/${PIPE}/board${opts.query ? `?${opts.query}` : ""}`;
  return GET(new Request(url, { headers: headers(opts.etag) }), ctx());
}

function postBoard(body: unknown, etag?: string | null) {
  return POST(
    new Request(`http://localhost/api/pipelines/${PIPE}/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers(etag) },
      body: JSON.stringify(body),
    }),
    ctx(),
  );
}

function postColumns(body: unknown, etag?: string | null) {
  return POST_COLUMNS(
    new Request(`http://localhost/api/pipelines/${PIPE}/board/columns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers(etag) },
      body: JSON.stringify(body),
    }),
    ctx(),
  );
}

function etagOf(res: Response): string {
  const etag = res.headers.get("etag");
  expect(etag).toMatch(/^W\/"[a-f0-9]{32}"$/);
  return etag!;
}

function versionRaw(name: string): string | undefined {
  return h.redis.store.get(`cache:v:${name}`)?.value;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.db.length = 0;
  h.boardLoads = 0;
  h.columnLoads = 0;
  h.session = { id: "u-manager", role: "MANAGER", org: "org-a" };
  h.settings = new Map();
  resetCacheVersionsForTests();
  resetCoalesceForTests();
  resetBoardCardWritesForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("304 sem banco", () => {
  it("GET: 200 com ETag/Cache-Control; o mesmo ETag de volta = 304 sem corpo, sem carga e sem banco", async () => {
    const first = await getBoard();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("Cookie");
    const etag = etagOf(first);
    expect(h.boardLoads).toBe(1);

    const again = await getBoard({ etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(h.boardLoads).toBe(1);
    // Nenhum acesso ao Prisma em todo o caminho (sessão, authz, visibilidade, versões).
    expect(h.db).toEqual([]);
  });

  it("POST: ETag pelo corpo canônico — ordem de chaves/ids e filtro vazio não mudam; filtro novo muda", async () => {
    const body = { status: "OPEN", perStage: 50, filters: { tagIds: ["t2", "t1"], ownerIds: ["u1"] } };
    const first = await postBoard(body);
    expect(first.status).toBe(200);
    const etag = etagOf(first);

    const reordered = await postBoard(
      { filters: { ownerIds: ["u1"], tagIds: ["t1", "t2"], search: "  " }, perStage: 50, status: "OPEN" },
      etag,
    );
    expect(reordered.status).toBe(304);
    expect(h.boardLoads).toBe(1);

    const other = await postBoard({ ...body, filters: { tagIds: ["t3"] } }, etag);
    expect(other.status).toBe(200);
    expect(etagOf(other)).not.toBe(etag);
    expect(h.db).toEqual([]);
  });

  it("POST sem filtro tem o mesmo ETag do GET equivalente", async () => {
    const get = await getBoard({ query: "perStage=10" });
    const post = await postBoard({ status: "OPEN", perStage: 10, filters: {} }, etagOf(get));
    expect(post.status).toBe(304);
  });

  it("colunas: repetir o pedido = 304; outro cursor = 200", async () => {
    const body = { status: "OPEN", columns: [{ stageId: "st1", cursor: "c1", limit: 30 }] };
    const first = await postColumns(body);
    expect(first.status).toBe(200);
    const etag = etagOf(first);
    const again = await postColumns(body, etag);
    expect(again.status).toBe(304);
    expect(h.columnLoads).toBe(1);
    const next = await postColumns({ ...body, columns: [{ stageId: "st1", cursor: "c2", limit: 30 }] }, etag);
    expect(next.status).toBe(200);
    expect(h.db).toEqual([]);
  });

  it("view=stages também responde 304", async () => {
    // Só o 304: o 200 lê as etapas no banco (stage.findMany), que aqui é falso.
    const etag = await computeBoardEtag({
      orgId: "org-a",
      pipelineId: PIPE,
      kind: "stages",
      variant: JSON.stringify({ sv: "*" }),
      freshness: { activity: false, volatile: false },
    });
    const res = await getBoard({ query: "view=stages", etag });
    expect(res.status).toBe(304);
    expect(h.db).toEqual([]);
  });
});

describe("quem muda o ETag", () => {
  it("mensagem (purga coalescida) NÃO muda o ETag do board por posição", async () => {
    const etag = etagOf(await getBoard());
    const before = versionRaw(`board_act:org-a:${PIPE}`);
    scheduleBoardInvalidationForMessages("org-a", PIPE);
    await vi.waitFor(() => expect(versionRaw(`board_act:org-a:${PIPE}`)).not.toBe(before));
    // Sem org/pipeline: versão de atividade da org.
    scheduleBoardInvalidationForMessages("org-a");
    await vi.waitFor(() => expect(versionRaw("board_act:org-a")).toBeDefined());

    const res = await getBoard({ etag });
    expect(res.status).toBe(304);
    expect(h.boardLoads).toBe(1);
  });

  it("mensagem muda o ETag quando a ordem é por última interação", async () => {
    const query = "sort=lastInteraction&direction=desc";
    const etag = etagOf(await getBoard({ query }));
    expect((await getBoard({ query, etag })).status).toBe(304);
    scheduleBoardInvalidationForMessages("org-a", PIPE);
    await vi.waitFor(async () => {
      const res = await getBoard({ query, etag });
      expect(res.status).toBe(200);
    });
  });

  it("filtro de conversa (última mensagem do cliente) também acompanha a atividade", async () => {
    const body = { filters: { lastMessageDirection: "in" } };
    const etag = etagOf(await postBoard(body));
    scheduleBoardInvalidationForMessages("org-a", PIPE);
    await vi.waitFor(async () => expect((await postBoard(body, etag)).status).toBe(200));
  });

  it("escritor de card do funil (invalidateBoardData) e da org (invalidateOrgBoards) mudam", async () => {
    const etag = etagOf(await getBoard());
    await invalidateBoardData("org-a", PIPE);
    const res = await getBoard({ etag });
    expect(res.status).toBe(200);
    const etag2 = etagOf(res);
    await invalidateOrgBoards("org-a");
    expect((await getBoard({ etag: etag2 })).status).toBe(200);
  });

  it("outro funil não muda o ETag deste", async () => {
    const etag = etagOf(await getBoard());
    await invalidateBoardData("org-a", "cmoutrofunil00000000001");
    expect((await getBoard({ etag })).status).toBe(304);
  });

  it("escrita pelo prisma em model do card (tarefa) troca a versão da org; lastMessageAt do contato não", async () => {
    const etag = etagOf(await getBoard());
    runWithContext({ organizationId: "org-a", userId: "u", isSuperAdmin: false } as never, () =>
      noteBoardCardWrite("Contact", "update", { where: { id: "c" }, data: { lastMessageAt: new Date() } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect((await getBoard({ etag })).status).toBe(304);

    runWithContext({ organizationId: "org-a", userId: "u", isSuperAdmin: false } as never, () =>
      noteBoardCardWrite("Activity", "update", { where: { id: "a1" }, data: { completed: true } }),
    );
    await vi.waitFor(async () => expect((await getBoard({ etag })).status).toBe(200));
  });

  it("balde de 15 min: o ETag vira sozinho (isRotting / rede de segurança)", async () => {
    const etag = etagOf(await getBoard());
    vi.setSystemTime(T0 + BOARD_ETAG_SAFETY_BUCKET_MS);
    expect((await getBoard({ etag })).status).toBe(200);
  });
});

describe("isolamento", () => {
  it("org B nunca casa o ETag da org A (mesmo funil, mesmo pedido)", async () => {
    const etagA = etagOf(await getBoard());
    h.session = { id: "u-manager", role: "MANAGER", org: "org-b" };
    const res = await getBoard({ etag: etagA });
    expect(res.status).toBe(200);
    expect(etagOf(res)).not.toBe(etagA);
  });

  it("quem só vê os próprios negócios nunca recebe 304 com o ETag de quem vê todos", async () => {
    // MANAGER: vê todos (padrão). MEMBER: só os próprios (padrão).
    const etagAll = etagOf(await getBoard());

    h.session = { id: "u-member-1", role: "MEMBER", org: "org-a" };
    const own = await getBoard({ etag: etagAll });
    expect(own.status).toBe(200);
    const etagOwn = etagOf(own);
    expect(etagOwn).not.toBe(etagAll);
    expect((await getBoard({ etag: etagOwn })).status).toBe(304);

    // Outro MEMBER: outro dono no where, outro ETag.
    h.session = { id: "u-member-2", role: "MEMBER", org: "org-a" };
    expect((await getBoard({ etag: etagOwn })).status).toBe(200);

    // E de volta: quem vê todos não reaproveita o ETag de quem vê só os seus.
    h.session = { id: "u-manager", role: "MANAGER", org: "org-a" };
    expect((await getBoard({ etag: etagOwn })).status).toBe(200);
    // POST e colunas seguem a mesma regra.
    const postAll = etagOf(await postBoard({ filters: { tagIds: ["t1"] } }));
    h.session = { id: "u-member-1", role: "MEMBER", org: "org-a" };
    expect((await postBoard({ filters: { tagIds: ["t1"] } }, postAll)).status).toBe(200);
  });

  it("mudar a visibilidade do papel (setting) muda o ETag", async () => {
    h.session = { id: "u-member-1", role: "MEMBER", org: "org-a" };
    const etag = etagOf(await getBoard());
    h.settings.set("visibility.MEMBER", "all");
    expect((await getBoard({ etag })).status).toBe(200);
  });
});

describe("outra réplica", () => {
  it("bump de card feito por outra réplica vale na leitura seguinte (≤ 5 s)", async () => {
    const etag = etagOf(await getBoard());
    vi.resetModules();
    const replicaB = await import("@/lib/cache/keys");
    await replicaB.invalidateBoardData("org-a", PIPE);
    // Família `board` sem memória local: na hora.
    expect((await getBoard({ etag })).status).toBe(200);
  });

  it("bump de atividade de outra réplica vale em ≤ 5 s (memória local de 500 ms)", async () => {
    const query = "sort=lastInteraction&direction=desc";
    const etag = etagOf(await getBoard({ query }));
    vi.resetModules();
    const replicaB = await import("@/lib/cache/keys");
    await replicaB.invalidateBoardActivity("org-a", PIPE);
    vi.setSystemTime(T0 + 5_000);
    expect((await getBoard({ query, etag })).status).toBe(200);
  });
});
