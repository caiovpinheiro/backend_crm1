/**
 * Rotas de inicialização em cache (`services/startup-cache.ts` +
 * `lib/cache/response-cache.ts`), ponta a ponta sobre um Redis falso e um
 * Prisma falso que conta consultas:
 *
 * - 304 com `If-None-Match` igual: zero consultas Prisma e loader não roda;
 * - invalidação explícita pelos escritores reais (criar resposta rápida,
 *   mudar departamento, editar usuário, renomear funil): a próxima leitura
 *   traz o dado novo e o ETag muda;
 * - isolamento: org A nunca recebe corpo/ETag da org B (mesmos ids); perfis
 *   diferentes na mesma org não compartilham entrada;
 * - bootstrap (`blocks`): corpo de cada bloco idêntico ao da rota, mesmo
 *   cache, 304 sem ler corpo de bloco e sem banco, isolamento por org.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;

  type Row = Record<string, unknown>;
  const tables = new Map<string, Row[]>();
  const calls: string[] = [];
  let seq = 0;

  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v === undefined) return true;
      if (v !== null && typeof v === "object") return true; // filtros compostos: ignorados
      return row[k] === v;
    });
  }
  function table(model: string): Row[] {
    if (!tables.has(model)) tables.set(model, []);
    return tables.get(model)!;
  }
  function modelProxy(model: string) {
    return new Proxy(
      {},
      {
        get(_t, method: string) {
          return async (args: { where?: Row; data?: Row } = {}) => {
            calls.push(`${model}.${method}`);
            const rows = table(model);
            switch (method) {
              case "findMany":
                return rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r }));
              case "findFirst":
              case "findUnique": {
                const r = rows.find((x) => matches(x, args.where));
                return r ? { ...r } : null;
              }
              case "count":
                return rows.filter((r) => matches(r, args.where)).length;
              case "create": {
                const row = { id: `${model}_${++seq}`, ...args.data };
                rows.push(row);
                return { ...row };
              }
              case "update": {
                const r = rows.find((x) => matches(x, args.where));
                if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
                Object.assign(r, args.data);
                return { ...r };
              }
              case "updateMany":
              case "deleteMany":
                return { count: 0 };
              default:
                return null;
            }
          };
        },
      },
    );
  }
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$transaction") {
          return async (arg: unknown) => {
            calls.push("$transaction");
            return typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]);
          };
        }
        if (prop === "then") return undefined;
        return modelProxy(prop);
      },
    },
  );

  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
    tables,
    calls,
    prisma,
    session: {
      user: {
        id: "u_a",
        name: "Ana",
        email: "ana@a.test",
        role: "ADMIN" as string,
        organizationId: "org_a" as string | null,
        isSuperAdmin: false,
      },
    },
    channelsByOrg: new Map<string, unknown[]>(),
    pipelinesByOrg: new Map<string, { id: string; name: string; stages: { id: string; name: string }[] }[]>(),
    /** userId → negações de etapa (perfil de permissão). */
    stageDenyByUser: new Map<string, string[]>(),
    getChannels: vi.fn(),
    getPipelines: vi.fn(),
    buildMeBootstrap: vi.fn(),
    roomsByOrg: new Map<string, unknown[]>(),
    listRooms: vi.fn(),
    /** Usuários sem `pipeline:view`. */
    deniedPipelineUsers: new Set<string>(),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: h.prisma }));

vi.mock("@/lib/auth-helpers", () => {
  const ok = () => ({ ok: true, session: h.session });
  return {
    withOrgContext: async (cb: (s: unknown) => unknown) => cb(h.session),
    requireAuth: async () => ok(),
    requireAdmin: async () => ok(),
    userOrgFilter: (s: { user: { organizationId: string | null } }) =>
      s.user.organizationId ? { organizationId: s.user.organizationId } : {},
  };
});
vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: async () => ({ ok: true, user: h.session.user, viaToken: false }),
  runWithApiUserContext: (_u: unknown, fn: () => unknown) => fn(),
  withApiAuthContext: async (_r: Request, fn: (u: unknown) => unknown) => fn(h.session.user),
}));
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/authz", () => ({
  loadAuthzContext: async (input: { userId: string; organizationId: string }) => ({
    userId: input.userId,
    organizationId: input.organizationId,
    isSuperAdmin: false,
    isAdmin: false,
    permissions: new Set<string>(),
    stageView: null,
    stageDeny: new Set(h.stageDenyByUser.get(input.userId) ?? []),
    pipelineDeny: new Set<string>(),
  }),
  canViewPipeline: () => true,
  canViewStage: (ctx: { stageDeny: Set<string> }, id: string) => !ctx.stageDeny.has(id),
}));
vi.mock("@/lib/authz/resource-policy", () => ({
  listAllowedPipelineIds: async () => null,
  requirePermissionForUser: async (u: { id: string }, key: string) =>
    key === "pipeline:view" && h.deniedPipelineUsers.has(u.id)
      ? new Response(JSON.stringify({ message: "Acesso negado." }), { status: 403 })
      : null,
}));
vi.mock("@/services/me-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/me-bootstrap")>();
  return { ...actual, buildMeBootstrap: h.buildMeBootstrap };
});
vi.mock("@/lib/org-settings", () => ({
  getOrgSetting: async () => null,
  getOrgSettingsByPrefix: async () => new Map([["conversation.signature", "true"]]),
  setOrgSetting: vi.fn(),
}));
vi.mock("@/lib/visibility", () => ({
  getVisibilitySettings: async () => ({ ADMIN: "all", MANAGER: "all", MEMBER: "own" }),
}));
vi.mock("@/services/channels", () => ({
  getChannels: h.getChannels,
  createChannel: vi.fn(),
}));
vi.mock("@/services/pipelines", async () => {
  const { bumpResponseFamilies, RESPONSE_FAMILIES } = await import(
    "@/lib/cache/response-families"
  );
  return {
    getPipelines: h.getPipelines,
    createPipeline: vi.fn(),
    // Mesmo efeito do escritor real (`invalidatePipelinesMeta`), sem o resto
    // do serviço (que puxa o motor de negócios inteiro).
    invalidatePipelinesMeta: (orgId: string) =>
      bumpResponseFamilies(orgId, RESPONSE_FAMILIES.pipelines),
  };
});
vi.mock("@/services/loss-reasons", () => ({ listLossReasons: async () => [] }));
vi.mock("@/services/quick-replies", () => ({ getQuickReplies: async () => [] }));
vi.mock("@/services/system-presence", () => ({ getSystemPresenceMap: async () => new Map() }));
vi.mock("@/services/api4com/provisioning", () => ({
  getProvisioningStatusMany: async () => new Map(),
  disableTelephony: async () => ({ success: true }),
}));
vi.mock("@/services/tabulations", () => ({ assertLeafInDepartment: vi.fn() }));
vi.mock("@/services/team-chat", () => ({ listRooms: h.listRooms, createRoom: vi.fn() }));
vi.mock("@/lib/auth/lockout", () => ({ clearLoginLockout: vi.fn() }));
vi.mock("@/lib/auth/session-revocation", () => ({
  SESSION_VERSION_BUMP: {},
  notifySessionsRevoked: vi.fn(),
}));
vi.mock("@/lib/authz/sync-user-role", () => ({ syncUserRoleAssignment: vi.fn() }));

import { GET as bootstrapGet } from "@/app/api/me/bootstrap/route";
import { GET as cardExtensionGet } from "@/app/api/custom-fields/card-extension/route";
import { GET as channelsGet } from "@/app/api/channels/route";
import { GET as fieldLayoutGet } from "@/app/api/field-layout/route";
import { GET as orgSettingsGet } from "@/app/api/settings/org/route";
import { GET as quickReplyGroupsGet } from "@/app/api/settings/quick-replies/groups/route";
import { GET as teamChatRoomsGet } from "@/app/api/team-chat/rooms/route";
import { GET as visibilityGet } from "@/app/api/settings/visibility/route";
import { GET as departmentsGet } from "@/app/api/settings/departments/route";
import { PUT as departmentPut } from "@/app/api/settings/departments/[id]/route";
import { GET as pipelinesGet } from "@/app/api/pipelines/route";
import {
  GET as settingsQuickRepliesGet,
  POST as settingsQuickRepliesPost,
} from "@/app/api/settings/quick-replies/route";
import { GET as usersGet } from "@/app/api/users/route";
import { PUT as userPut } from "@/app/api/users/[id]/route";
import { writeBrowserApiCorsHeaders } from "@/lib/browser-api-cors";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import { resetResponseCacheMemoForTests } from "@/lib/cache/response-cache";
import { BOOTSTRAP_BLOCK_URLS } from "@/services/bootstrap-blocks";
import { invalidatePipelinesMeta } from "@/services/pipelines";

function asUser(orgId: string, userId: string, role = "ADMIN") {
  h.session.user = { ...h.session.user, id: userId, organizationId: orgId, role };
}

function get(path: string, etag?: string | null): Request {
  return new Request(`https://api.test${path}`, {
    headers: etag ? { "if-none-match": etag } : {},
  });
}

function json(path: string, method: string, body: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.tables.clear();
  h.calls.length = 0;
  h.stageDenyByUser.clear();
  h.deniedPipelineUsers.clear();
  h.roomsByOrg.set("org_a", [{ id: "r1", name: "Geral A", unread: 0 }]);
  h.roomsByOrg.set("org_b", [{ id: "r1", name: "Geral B", unread: 0 }]);
  h.listRooms.mockImplementation(async (v: { organizationId: string }) =>
    structuredClone(h.roomsByOrg.get(v.organizationId) ?? []),
  );
  // Como o serviço real: a lista completa das salas sai da mesma consulta
  // do resumo `teamChatRooms` e é entregue pelo hook.
  h.buildMeBootstrap.mockImplementation(
    async (
      user: { id: string; organizationId: string },
      hooks?: { onTeamChatRooms?: (rooms: unknown[]) => void },
    ) => {
      const rooms = await h.listRooms({ userId: user.id, organizationId: user.organizationId });
      hooks?.onTeamChatRooms?.(rooms);
      return {
        version: 1,
        user: { id: user.id, organizationId: user.organizationId, isSuperAdmin: false },
        profile: { id: user.id },
        failedBlocks: [],
      };
    },
  );
  resetCacheVersionsForTests();
  resetResponseCacheMemoForTests();
  vi.clearAllMocks();
  asUser("org_a", "u_a");

  // Mesmos ids nas duas orgs, de propósito.
  h.channelsByOrg.set("org_a", [{ id: "ch1", name: "Comercial A" }]);
  h.channelsByOrg.set("org_b", [{ id: "ch1", name: "Comercial B" }]);
  h.getChannels.mockImplementation(async () => h.channelsByOrg.get(h.session.user.organizationId!));
  h.pipelinesByOrg.set("org_a", [
    { id: "p1", name: "Vendas A", stages: [{ id: "s1", name: "Novo" }, { id: "s2", name: "Proposta" }] },
  ]);
  h.pipelinesByOrg.set("org_b", [
    { id: "p1", name: "Vendas B", stages: [{ id: "s1", name: "Novo" }, { id: "s2", name: "Proposta" }] },
  ]);
  h.getPipelines.mockImplementation(async () =>
    structuredClone(h.pipelinesByOrg.get(h.session.user.organizationId!)),
  );

  const t = (m: string) => {
    if (!h.tables.has(m)) h.tables.set(m, []);
    return h.tables.get(m)!;
  };
  t("quickReply").push(
    { id: "qr1", organizationId: "org_a", title: "Oi", content: "Olá!", position: 0 },
    { id: "qr1b", organizationId: "org_b", title: "Oi B", content: "Olá B", position: 0 },
  );
  t("department").push(
    { id: "d1", organizationId: "org_a", name: "Suporte", color: "#000000" },
    { id: "d1b", organizationId: "org_b", name: "Suporte B", color: "#000000" },
  );
  t("user").push(
    { id: "u_a", organizationId: "org_a", name: "Ana", type: "HUMAN", isErased: false, roleAssignments: [], agentStatus: null },
    { id: "u_b", organizationId: "org_b", name: "Bia", type: "HUMAN", isErased: false, roleAssignments: [], agentStatus: null },
  );
});

describe("304 sem tocar no banco", () => {
  const routes: [string, (r: Request) => Promise<Response>, string][] = [
    ["/api/channels", channelsGet as (r: Request) => Promise<Response>, "getChannels"],
    ["/api/pipelines", pipelinesGet as (r: Request) => Promise<Response>, "getPipelines"],
    ["/api/users", usersGet as (r: Request) => Promise<Response>, "user.findMany"],
    ["/api/settings/quick-replies", settingsQuickRepliesGet as (r: Request) => Promise<Response>, "quickReply.findMany"],
    ["/api/settings/departments", departmentsGet as (r: Request) => Promise<Response>, "department.findMany"],
  ];

  it.each(routes)("%s: 200 com ETag; depois 304 com zero consultas", async (path, handler) => {
    const first = await handler(get(path));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);

    h.calls.length = 0;
    h.getChannels.mockClear();
    h.getPipelines.mockClear();
    const second = await handler(get(path, etag));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
    expect(h.calls).toEqual([]);
    expect(h.getChannels).not.toHaveBeenCalled();
    expect(h.getPipelines).not.toHaveBeenCalled();
    expect(second.headers.get("server-timing") ?? "").not.toContain("query");
  });

  it("sem If-None-Match, o acerto do cache também não consulta o banco", async () => {
    await usersGet(get("/api/users"));
    h.calls.length = 0;
    const again = await usersGet(get("/api/users"));
    expect(again.status).toBe(200);
    expect(h.calls).toEqual([]);
  });
});

describe("invalidação pelos escritores", () => {
  it("criar resposta rápida: a lista traz a nova e o ETag muda", async () => {
    const before = await settingsQuickRepliesGet(get("/api/settings/quick-replies"));
    const etag = before.headers.get("etag");

    const created = await settingsQuickRepliesPost(
      json("/api/settings/quick-replies", "POST", { title: "Tchau", content: "Até logo" }),
    );
    expect(created.status).toBe(201);

    const after = await settingsQuickRepliesGet(get("/api/settings/quick-replies", etag));
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const titles = ((await after.json()) as { title: string }[]).map((r) => r.title);
    expect(titles).toEqual(["Oi", "Tchau"]);
  });

  it("mudar departamento: a lista traz o nome novo e o ETag muda", async () => {
    const before = await departmentsGet(get("/api/settings/departments"));
    const etag = before.headers.get("etag");

    const put = await departmentPut(json("/api/settings/departments/d1", "PUT", { name: "Atendimento" }), {
      params: Promise.resolve({ id: "d1" }),
    });
    expect(put.status).toBe(200);

    const after = await departmentsGet(get("/api/settings/departments", etag));
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(((await after.json()) as { name: string }[]).map((d) => d.name)).toEqual(["Atendimento"]);
  });

  it("editar usuário: a lista traz o nome novo e o ETag muda", async () => {
    const before = await usersGet(get("/api/users"));
    const etag = before.headers.get("etag");

    const put = await userPut(json("/api/users/u_a", "PUT", { name: "Ana Paula" }), {
      params: Promise.resolve({ id: "u_a" }),
    });
    expect(put.status).toBe(200);

    const after = await usersGet(get("/api/users", etag));
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(((await after.json()) as { name: string }[])[0].name).toBe("Ana Paula");
  });

  it("renomear funil: a lista traz o nome novo e o ETag muda", async () => {
    const before = await pipelinesGet(get("/api/pipelines"));
    const etag = before.headers.get("etag");

    h.pipelinesByOrg.get("org_a")![0].name = "Vendas 2026";
    await invalidatePipelinesMeta("org_a");

    const after = await pipelinesGet(get("/api/pipelines", etag));
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(((await after.json()) as { name: string }[])[0].name).toBe("Vendas 2026");
  });

  it("escrita na org B não invalida a org A", async () => {
    const a = await settingsQuickRepliesGet(get("/api/settings/quick-replies"));
    const etagA = a.headers.get("etag");

    asUser("org_b", "u_b");
    await settingsQuickRepliesPost(
      json("/api/settings/quick-replies", "POST", { title: "Nova B", content: "x" }),
    );

    asUser("org_a", "u_a");
    h.calls.length = 0;
    const again = await settingsQuickRepliesGet(get("/api/settings/quick-replies", etagA));
    expect(again.status).toBe(304);
    expect(h.calls).toEqual([]);
  });
});

describe("isolamento", () => {
  it("org A nunca recebe corpo nem 304 com o ETag da org B (mesmos ids)", async () => {
    asUser("org_b", "u_b");
    const b = await channelsGet(get("/api/channels"));
    const etagB = b.headers.get("etag");
    expect(await b.json()).toEqual({ channels: [{ id: "ch1", name: "Comercial B" }] });

    asUser("org_a", "u_a");
    const a = await channelsGet(get("/api/channels", etagB));
    expect(a.status).toBe(200);
    expect(a.headers.get("etag")).not.toBe(etagB);
    expect(await a.json()).toEqual({ channels: [{ id: "ch1", name: "Comercial A" }] });
  });

  it("mesmo perfil e mesmos ids de funil em orgs diferentes: entradas separadas", async () => {
    asUser("org_b", "u_b");
    const b = await pipelinesGet(get("/api/pipelines"));
    asUser("org_a", "u_a");
    const a = await pipelinesGet(get("/api/pipelines", b.headers.get("etag")));
    expect(a.status).toBe(200);
    expect(((await a.json()) as { name: string }[])[0].name).toBe("Vendas A");
    expect(h.getPipelines).toHaveBeenCalledTimes(2);
  });

  it("perfis de permissão diferentes na mesma org não compartilham entrada", async () => {
    h.stageDenyByUser.set("u_restrito", ["s2"]);
    const full = await pipelinesGet(get("/api/pipelines"));
    const fullEtag = full.headers.get("etag");

    asUser("org_a", "u_restrito", "MEMBER");
    const restricted = await pipelinesGet(get("/api/pipelines", fullEtag));
    expect(restricted.status).toBe(200);
    const stages = ((await restricted.json()) as { stages: { id: string }[] }[])[0].stages;
    expect(stages.map((s) => s.id)).toEqual(["s1"]);

    // Outro usuário com o MESMO perfil reaproveita a entrada (sem loader).
    h.stageDenyByUser.set("u_restrito2", ["s2"]);
    asUser("org_a", "u_restrito2", "MEMBER");
    h.getPipelines.mockClear();
    const same = await pipelinesGet(get("/api/pipelines", restricted.headers.get("etag")));
    expect(same.status).toBe(304);
    expect(h.getPipelines).not.toHaveBeenCalled();
  });

  it("departamentos: MEMBER e ADMIN da mesma org têm variantes separadas", async () => {
    const admin = await departmentsGet(get("/api/settings/departments"));
    asUser("org_a", "u_m", "MEMBER");
    const member = await departmentsGet(get("/api/settings/departments"));
    expect(member.status).toBe(200);
    expect(admin.status).toBe(200);
    // Cada papel carregou a própria entrada (o Prisma falso ignora `select`,
    // então os corpos aqui coincidem; no banco real o MEMBER não leva contagens).
    expect(h.calls.filter((c) => c === "department.findMany")).toHaveLength(2);
  });
});

describe("GET /api/me/bootstrap — blocks", () => {
  const ROUTE_BY_URL: Record<string, (r: Request) => Promise<Response>> = {
    "/api/team-chat/rooms": teamChatRoomsGet as unknown as (r: Request) => Promise<Response>,
    "/api/pipelines": pipelinesGet as (r: Request) => Promise<Response>,
    "/api/settings/org?prefix=conversation.": orgSettingsGet as (r: Request) => Promise<Response>,
    "/api/settings/visibility": visibilityGet as (r: Request) => Promise<Response>,
    "/api/channels": channelsGet as (r: Request) => Promise<Response>,
    "/api/users": usersGet as (r: Request) => Promise<Response>,
    "/api/settings/quick-replies": settingsQuickRepliesGet as (r: Request) => Promise<Response>,
    "/api/settings/quick-replies/groups": quickReplyGroupsGet as (r: Request) => Promise<Response>,
    "/api/custom-fields/card-extension": cardExtensionGet as (r: Request) => Promise<Response>,
    "/api/field-layout?context=deal_panel_v2&forUser=true": fieldLayoutGet as (r: Request) => Promise<Response>,
  };

  async function bootstrap(etag?: string | null) {
    return bootstrapGet(get("/api/me/bootstrap", etag));
  }

  it("traz um bloco por URL do contrato, com o corpo idêntico ao da rota", async () => {
    const res = await bootstrap();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const body = (await res.json()) as { blocks: Record<string, unknown>; blockErrors: string[] };
    expect(Object.keys(body.blocks)).toEqual([...BOOTSTRAP_BLOCK_URLS]);
    expect(body.blockErrors).toEqual([]);

    // Corpo idêntico ao da rota individual; as cacheadas saem do MESMO cache
    // (acerto, sem banco). `/api/team-chat/rooms` é por usuário e sem cache.
    h.calls.length = 0;
    for (const url of BOOTSTRAP_BLOCK_URLS) {
      const route = await ROUTE_BY_URL[url](get(url));
      expect(route.status, url).toBe(200);
      expect(await route.json(), url).toEqual(body.blocks[url]);
    }
    expect(h.calls).toEqual([]);
    expect(body.blocks["/api/team-chat/rooms"]).toEqual({
      rooms: [{ id: "r1", name: "Geral A", unread: 0 }],
    });
  });

  it("304 com o ETag guardado: sem ler corpo de bloco e sem consultas", async () => {
    const first = await bootstrap();
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);

    resetResponseCacheMemoForTests(); // outra réplica: ETags só no Redis
    h.calls.length = 0;
    h.redis.calls.length = 0;
    h.getChannels.mockClear();
    h.getPipelines.mockClear();
    const second = await bootstrap(etag);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(h.calls).toEqual([]);
    expect(h.getChannels).not.toHaveBeenCalled();
    expect(h.getPipelines).not.toHaveBeenCalled();
    const bodyReads = h.redis.calls.filter(
      (c) => c.startsWith("GET cache:resp:") && !c.endsWith(":etag"),
    );
    expect(bodyReads).toEqual([]);
  });

  it("criar resposta rápida muda o bloco e o ETag do bootstrap", async () => {
    const first = await bootstrap();
    const etag = first.headers.get("etag");
    await settingsQuickRepliesPost(
      json("/api/settings/quick-replies", "POST", { title: "Nova", content: "x" }),
    );
    const second = await bootstrap(etag);
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    const body = (await second.json()) as { blocks: Record<string, { title: string }[]> };
    expect(body.blocks["/api/settings/quick-replies"].map((r) => r.title)).toEqual(["Oi", "Nova"]);
  });

  it("org A nunca recebe blocos nem 304 da org B (mesmos ids de canal e funil)", async () => {
    asUser("org_b", "u_b");
    const b = await bootstrap();
    const etagB = b.headers.get("etag");

    asUser("org_a", "u_a");
    const a = await bootstrap(etagB);
    expect(a.status).toBe(200);
    expect(a.headers.get("etag")).not.toBe(etagB);
    const text = await a.text();
    expect(text).toContain("Comercial A");
    expect(text).toContain("Vendas A");
    expect(text).not.toContain("Comercial B");
    expect(text).not.toContain("Vendas B");
    expect(text).not.toContain("Oi B");
  });

  it("dois usuários do mesmo perfil e org: o ETag do bootstrap leva o usuário", async () => {
    const a1 = await bootstrap();
    asUser("org_a", "u_a2");
    const a2 = await bootstrap(a1.headers.get("etag"));
    expect(a2.status).toBe(200);
    expect(a2.headers.get("etag")).not.toBe(a1.headers.get("etag"));
  });

  it("sem pipeline:view o bloco /api/pipelines não vem (a rota daria 403)", async () => {
    h.deniedPipelineUsers.add("u_a");
    const res = await bootstrap();
    const body = (await res.json()) as { blocks: Record<string, unknown> };
    expect(body.blocks["/api/pipelines"]).toBeUndefined();
    expect(body.blocks["/api/channels"]).toBeDefined();
  });

  it("salas do team-chat mudaram (não lida): o ETag do bootstrap muda", async () => {
    const first = await bootstrap();
    const etag = first.headers.get("etag");
    h.roomsByOrg.set("org_a", [{ id: "r1", name: "Geral A", unread: 3 }]);
    const second = await bootstrap(etag);
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    const body = (await second.json()) as { blocks: Record<string, { rooms: { unread: number }[] }> };
    expect(body.blocks["/api/team-chat/rooms"].rooms[0].unread).toBe(3);
  });

  it("sem /api/activities/alerts (o GET marca o alerta como entregue)", async () => {
    expect(BOOTSTRAP_BLOCK_URLS).not.toContain("/api/activities/alerts");
  });
});

describe("cabeçalhos do 304 (cache do navegador, cross-origin)", () => {
  const ORIGIN = "https://acme.bwipo.com";

  /** O que o middleware faz na resposta de toda rota `/api/*`. */
  function withCors(res: Response): Response {
    writeBrowserApiCorsHeaders(
      { headers: new Headers({ origin: ORIGIN }) },
      res,
      ORIGIN,
    );
    return res;
  }

  function expectCacheAndCors(res: Response, etag: string | null) {
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const vary = (res.headers.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());
    expect(vary).toEqual(expect.arrayContaining(["origin", "cookie", "authorization"]));
    expect(vary.filter((v) => v === "origin")).toHaveLength(1);
  }

  it.each([
    ["/api/channels", channelsGet as (r: Request) => Promise<Response>],
    ["/api/me/bootstrap", bootstrapGet as (r: Request) => Promise<Response>],
  ])("%s: 200 e 304 com os mesmos cabeçalhos de CORS, ETag, Cache-Control e Vary", async (path, handler) => {
    const ok = withCors(await handler(get(path)));
    expect(ok.status).toBe(200);
    const etag = ok.headers.get("etag");
    expectCacheAndCors(ok, etag);

    const notModified = withCors(await handler(get(path, etag)));
    expect(notModified.status).toBe(304);
    expectCacheAndCors(notModified, etag);
    for (const h2 of ["access-control-allow-origin", "access-control-allow-credentials", "vary", "cache-control"]) {
      expect(notModified.headers.get(h2), h2).toBe(ok.headers.get(h2));
    }
  });
});
