/**
 * Bootstrap v2 (`x-bootstrap-version: 2`) e `GET /api/me/live`, ponta a
 * ponta sobre um Redis falso e um Prisma falso que conta consultas. O
 * payload estável é montado pelo serviço REAL (`buildMeBootstrapStable`);
 * só os serviços de baixo (preferências, widgets, org, e-mail, team-chat,
 * permissões efetivas) são trocados por stubs que também contam chamadas.
 *
 * - 304 do v2 com zero consultas (e sem ler corpo no Redis), também na
 *   "outra réplica" (memória de ETag zerada);
 * - o ETag do v2 NÃO muda com status do agente / não lidas / team-chat;
 * - muda depois de editar perfil, permissão/papel, departamento do usuário
 *   e setting da org (pelos escritores reais);
 * - isolamento por usuário e org (mesmo id de usuário em orgs diferentes);
 * - bump feito por outra réplica vale em ≤ 5 s (versão lida do Redis);
 * - `/api/me/live` com o formato exato dos campos que saíram do v1;
 * - `/api/users` e `/api/settings/departments` com `x-bootstrap-version: 2`
 *   (rota e bloco) sem presença/status/abertas; o ETag do v2 não muda com
 *   eles e muda com edição de usuário/departamento; o live
 *   (`usersPresence`/`departmentCounts`) reconstrói o corpo legado; sem o
 *   header, as rotas como antes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      if (v !== null && typeof v === "object") return true;
      return row[k] === v;
    });
  }
  function table(model: string): Row[] {
    if (!tables.has(model)) tables.set(model, []);
    return tables.get(model)!;
  }
  /** `select` de 1º nível; `user.agentStatus` vem da tabela de status. */
  function project(model: string, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (model === "user" && k === "agentStatus") {
        const st = table("agentStatus").find((x) => x.userId === row.id);
        out[k] = st
          ? { status: st.status, availableForVoiceCalls: st.availableForVoiceCalls, updatedAt: st.updatedAt }
          : null;
        continue;
      }
      if (k in row) out[k] = row[k];
    }
    return out;
  }
  /** `include: { _count: { select } }`: só as contagens pedidas (do `_count` da linha). */
  function withCount(out: Row, row: Row, include: Row | undefined): Row {
    const { _count: _ignored, ...rest } = out;
    void _ignored;
    const sel = (include?._count as { select?: Row } | undefined)?.select;
    if (!sel) return rest;
    const counts = (row._count ?? {}) as Row;
    return { ...rest, _count: Object.fromEntries(Object.keys(sel).map((k) => [k, counts[k] ?? 0])) };
  }
  function modelProxy(model: string) {
    return new Proxy(
      {},
      {
        get(_t, method: string) {
          return async (
            args: {
              where?: Row; data?: Row; create?: Row; update?: Row; select?: Row; include?: Row; by?: string[];
            } = {},
          ) => {
            calls.push(`${model}.${method}`);
            const rows = table(model);
            switch (method) {
              case "findMany":
                return rows
                  .filter((r) => matches(r, args.where))
                  .map((r) => withCount(project(model, r, args.select), r, args.include));
              case "findFirst":
              case "findUnique": {
                const r = rows.find((x) => matches(x, args.where));
                return r ? project(model, r, args.select) : null;
              }
              case "groupBy": {
                // Só o que `services/me-live.ts` usa: conversas abertas por depto.
                const counts = new Map<string, number>();
                for (const r of rows.filter((x) => matches(x, args.where))) {
                  if (!r.departmentId) continue;
                  const k = String(r.departmentId);
                  counts.set(k, (counts.get(k) ?? 0) + 1);
                }
                return [...counts].map(([departmentId, n]) => ({ departmentId, _count: { _all: n } }));
              }
              case "update": {
                const r = rows.find((x) => matches(x, args.where));
                if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
                Object.assign(r, args.data);
                return { ...r, sessionVersion: 1 };
              }
              case "upsert": {
                const hit = rows.find((x) => matches(x, args.where));
                if (hit) {
                  Object.assign(hit, args.update);
                  return { ...hit };
                }
                const row = { id: `${model}_${++seq}`, ...args.create };
                rows.push(row);
                return { ...row };
              }
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
          return async (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => unknown)(prisma)
              : Promise.all(arg as unknown[]);
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
        role: "MEMBER" as string,
        organizationId: "org_a" as string | null,
        isSuperAdmin: false,
      },
    },
    /** `${org}:${user}` → permissões efetivas. */
    perms: new Map<string, string[]>(),
    /** org → config de alerta efetiva. */
    alertByOrg: new Map<string, Record<string, unknown>>(),
    emailAccounts: [] as { id: string; email: string; unreadCount: number }[],
    roomsByOrg: new Map<string, unknown[]>(),
    failPreferences: false,
    /** userId → presença de uso (heartbeat). */
    presence: new Map<string, { systemOnline: boolean; lastSeenAt: Date | null }>(),
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: h.prisma }));
vi.mock("@/lib/auth-helpers", async () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) => {
    const { runWithContext } = await import("@/lib/request-context");
    const u = h.session.user;
    return runWithContext(
      { organizationId: u.organizationId, userId: u.id, isSuperAdmin: u.isSuperAdmin },
      () => cb(h.session),
    );
  },
  requireAuth: async () => ({ ok: true, session: h.session }),
  requireAdmin: async () => ({ ok: true, session: h.session }),
  userOrgFilter: (s: { user: { organizationId: string | null } }) =>
    s.user.organizationId ? { organizationId: s.user.organizationId } : {},
}));
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/auth/session-renewal", () => ({ issueSessionRenewal: vi.fn() }));
vi.mock("@/lib/auth/session-revocation", () => ({
  SESSION_VERSION_BUMP: {},
  notifySessionsRevoked: vi.fn(),
}));
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ...actual,
    // Em produção vêm do cache de authz (Redis); aqui não contam consulta.
    loadAuthzContext: async (input: { userId: string; organizationId: string }) => ({
      userId: input.userId,
      organizationId: input.organizationId,
      isSuperAdmin: false,
      isAdmin: false,
      permissions: new Set(h.perms.get(`${input.organizationId}:${input.userId}`) ?? []),
      stageView: null,
      stageDeny: new Set<string>(),
      pipelineDeny: new Set<string>(),
    }),
    can: () => true,
    requirePermission: async () => null,
    canViewPipeline: () => true,
    canViewStage: () => true,
  };
});
vi.mock("@/lib/authz/resource-policy", () => ({
  listAllowedPipelineIds: async () => null,
  requirePermissionForUser: async () => null,
}));
vi.mock("@/services/effective-permissions", () => ({
  computeEffectivePermissions: async (u: { id: string; organizationId: string }) => {
    h.calls.push("computeEffectivePermissions");
    return {
      permissions: h.perms.get(`${u.organizationId}:${u.id}`) ?? [],
      channelGrants: [],
      stageGrants: [],
      roles: [],
      groups: [],
    };
  },
}));
vi.mock("@/lib/inbox-alert-config", () => ({
  DEFAULT_INBOX_ALERT_CONFIG: {},
  getEffectiveInboxAlerts: async (p: { organizationId: string }) => {
    h.calls.push("getEffectiveInboxAlerts");
    return { config: h.alertByOrg.get(p.organizationId) ?? {}, tabAudience: null };
  },
}));
vi.mock("@/services/organization-widgets", () => ({
  getActiveWidgetSlugs: async () => {
    h.calls.push("getActiveWidgetSlugs");
    return new Set(["calls_history"]);
  },
}));
vi.mock("@/services/organization-summary", () => ({
  getOrganizationSummary: async (orgId: string) => {
    h.calls.push("getOrganizationSummary");
    return { id: orgId, name: `Org ${orgId}`, slug: orgId, logoUrl: null, primaryColor: null, status: "ACTIVE", onboardingCompletedAt: null };
  },
}));
vi.mock("@/services/user-preferences", () => ({
  computeAvailableKeys: () => new Set(["nav:inbox"]),
  getSidebarPreferenceBundle: async () => {
    h.calls.push("getSidebarPreferenceBundle");
    if (h.failPreferences) throw new Error("db down");
    return { sidebar: { items: [] }, roleSidebar: null };
  },
  getDashboardPreferences: async () => ({ blocks: [] }),
  getAppearancePreferences: async () => ({ theme: "light" }),
}));
vi.mock("@/services/email-accounts", () => ({
  resolveEmailAccess: async () => ({ canViewShared: true, canViewOwn: true }),
  listEmailAccounts: async () => {
    h.calls.push("listEmailAccounts");
    return structuredClone(h.emailAccounts);
  },
}));
vi.mock("@/services/team-chat", () => ({
  listRooms: async (v: { organizationId: string }) => {
    h.calls.push("listRooms");
    return structuredClone(h.roomsByOrg.get(v.organizationId) ?? []);
  },
}));
// Blocos (`blocks`): mesmos stubs de `startup-cache-routes.test.ts`.
vi.mock("@/lib/visibility", () => ({
  getVisibilitySettings: async () => ({ ADMIN: "all", MANAGER: "all", MEMBER: "own" }),
}));
vi.mock("@/services/channels", () => ({ getChannels: async () => [{ id: "ch1", name: "Comercial" }] }));
vi.mock("@/services/pipelines", () => ({
  getPipelines: async () => [{ id: "p1", name: "Vendas", stages: [{ id: "s1", name: "Novo" }] }],
}));
vi.mock("@/services/loss-reasons", () => ({ listLossReasons: async () => [] }));
vi.mock("@/services/quick-replies", () => ({ getQuickReplies: async () => [] }));
vi.mock("@/services/system-presence", () => ({
  getSystemPresenceMap: async (p: { userIds?: string[] }) => {
    h.calls.push("getSystemPresenceMap");
    return new Map([...h.presence].filter(([id]) => !p.userIds || p.userIds.includes(id)));
  },
}));
// `PUT /api/agents/:id/status` real, sem os efeitos colaterais de fila/SSE.
vi.mock("@/lib/agent-presence", () => ({ recordPresenceTransition: vi.fn() }));
vi.mock("@/lib/realtime-events", () => ({
  publishPresenceUpdate: vi.fn(),
  publishSupportTicketUpdated: vi.fn(),
}));
vi.mock("@/services/distribution", () => ({ enqueueProcessPendingOrRun: vi.fn() }));
vi.mock("@/services/distribution/leads/pending", () => ({ drainLeadsPending: vi.fn() }));
vi.mock("@/services/support/distribution", () => ({ drainSupportQueue: vi.fn() }));
// `PUT /api/users/:id` e `PUT /api/settings/departments/:id` reais.
vi.mock("@/lib/auth/lockout", () => ({ clearLoginLockout: vi.fn() }));
vi.mock("@/lib/authz/sync-user-role", () => ({ syncUserRoleAssignment: vi.fn() }));
vi.mock("@/services/tabulations", () => ({ assertLeafInDepartment: vi.fn() }));
vi.mock("@/services/api4com/provisioning", () => ({ getProvisioningStatusMany: async () => new Map() }));

import { GET as bootstrapGet } from "@/app/api/me/bootstrap/route";
import { GET as liveGet } from "@/app/api/me/live/route";
import { PUT as agentStatusPut } from "@/app/api/agents/[id]/status/route";
import { PUT as profilePut } from "@/app/api/profile/route";
import { GET as departmentsGet } from "@/app/api/settings/departments/route";
import { PUT as departmentPut } from "@/app/api/settings/departments/[id]/route";
import { GET as usersGet } from "@/app/api/users/route";
import { PUT as userPut } from "@/app/api/users/[id]/route";
import { invalidateAuthzForUser } from "@/lib/authz";
import { resetResponseCacheMemoForTests } from "@/lib/cache/response-cache";
import { bumpCacheVersion, cacheVersionName, resetCacheVersionsForTests } from "@/lib/cache/versions";
import { USER_PRESENCE_DEFAULT } from "@/services/me-live";
import { setOrgSetting } from "@/lib/org-settings";
import { runWithContext } from "@/lib/request-context";
import { BOOTSTRAP_BLOCK_URLS } from "@/services/bootstrap-blocks";
import { addDepartmentMember } from "@/services/department-members";

const V2 = { "x-bootstrap-version": "2" };

function asUser(orgId: string, userId: string) {
  h.session.user = { ...h.session.user, id: userId, organizationId: orgId };
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.test${path}`, { headers });
}

async function v2(etag?: string | null): Promise<Response> {
  return bootstrapGet(req("/api/me/bootstrap", etag ? { ...V2, "if-none-match": etag } : V2));
}

function inOrg<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ organizationId: orgId, userId, isSuperAdmin: false }, fn) as Promise<T>;
}

/** Bump feito por OUTRA réplica: só o Redis muda (esta não fica sabendo). */
function bumpInRedisOnly(versionName: string): void {
  const key = `cache:v:${versionName}`;
  const hit = h.redis.store.get(key);
  expect(hit, key).toBeDefined();
  h.redis.store.set(key, { ...hit!, value: String(Number(hit!.value) + 1) });
}

const VOLATILE = ["agentStatus", "emailUnread", "teamChatRooms"];

beforeEach(() => {
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.tables.clear();
  h.calls.length = 0;
  h.perms.clear();
  h.alertByOrg.clear();
  h.failPreferences = false;
  h.presence.clear();
  h.presence.set("u_a", { systemOnline: true, lastSeenAt: new Date("2026-10-14T10:00:00.000Z") });
  h.emailAccounts = [{ id: "e1", email: "caixa@a.test", unreadCount: 0 }];
  h.roomsByOrg.set("org_a", [{ id: "r1", kind: "GROUP", name: "Geral A", unread: 0, muted: false, lastMessageAt: "2026-10-14T10:00:00.000Z", lastPreview: null }]);
  h.roomsByOrg.set("org_b", [{ id: "r1", kind: "GROUP", name: "Geral B", unread: 0, muted: false, lastMessageAt: "2026-10-14T10:00:00.000Z", lastPreview: null }]);
  resetCacheVersionsForTests();
  resetResponseCacheMemoForTests();
  asUser("org_a", "u_a");
  h.session.user = { ...h.session.user, role: "MEMBER" };
  h.perms.set("org_a:u_a", ["deal:view"]);

  const t = (m: string) => {
    if (!h.tables.has(m)) h.tables.set(m, []);
    return h.tables.get(m)!;
  };
  t("user").push(
    { id: "u_a", organizationId: "org_a", name: "Ana", email: "ana@a.test", role: "MEMBER", type: "HUMAN", isErased: false, isSuperAdmin: false, roleAssignments: [], agentStatus: null },
    { id: "u_b", organizationId: "org_b", name: "Bia", email: "bia@b.test", role: "MEMBER", type: "HUMAN", isErased: false, isSuperAdmin: false, roleAssignments: [], agentStatus: null },
  );
  t("department").push(
    { id: "d1", organizationId: "org_a", name: "Suporte", _count: { members: 1, conversations: 2 } },
    { id: "d2", organizationId: "org_a", name: "Vendas", _count: { members: 0, conversations: 0 } },
  );
  t("agentStatus").push({ userId: "u_a", status: "ONLINE", availableForVoiceCalls: false, updatedAt: new Date("2026-10-14T09:00:00.000Z") });
  t("conversation").push(
    { id: "c1", organizationId: "org_a", status: "OPEN", departmentId: "d1" },
    { id: "c2", organizationId: "org_a", status: "OPEN", departmentId: "d1" },
    { id: "c3", organizationId: "org_a", status: "RESOLVED", departmentId: "d2" },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/me/bootstrap v2 (x-bootstrap-version: 2)", () => {
  it("só o estável + blocks (sem team-chat), com ETag, no-cache e Vary da versão", async () => {
    const res = await v2();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const vary = (res.headers.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());
    expect(vary).toEqual(expect.arrayContaining(["origin", "cookie", "authorization", "x-bootstrap-version"]));

    const body = (await res.json()) as Record<string, unknown> & { blocks: Record<string, unknown> };
    expect(Object.keys(body)).toEqual([
      "version", "user", "profile", "preferences", "effectivePermissions",
      "organization", "alertConfig", "widgets", "failedBlocks", "blocks", "blockErrors",
    ]);
    expect(body.version).toBe(2);
    for (const k of VOLATILE) expect(body).not.toHaveProperty(k);
    expect(Object.keys(body.blocks)).toEqual(
      BOOTSTRAP_BLOCK_URLS.filter((u) => u !== "/api/team-chat/rooms"),
    );
    expect(body.blocks).toHaveProperty("/api/settings/departments");
    expect((body.profile as { name: string }).name).toBe("Ana");
  });

  it("304 com o ETag guardado: zero consultas, sem ler corpo, Server-Timing sem query", async () => {
    const first = await v2();
    const etag = first.headers.get("etag");
    expect(first.headers.get("server-timing")).toContain("query");

    resetResponseCacheMemoForTests(); // outra réplica: ETags só no Redis
    h.calls.length = 0;
    h.redis.calls.length = 0;
    const second = await v2(etag);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, no-cache");
    expect(h.calls).toEqual([]);
    const timing = second.headers.get("server-timing") ?? "";
    expect(timing).toContain('cache;dur=');
    expect(timing).toContain('desc="304"');
    expect(timing).not.toContain("query");
    const bodyReads = h.redis.calls.filter(
      (c) => c.startsWith("GET cache:resp:") && !c.endsWith(":etag"),
    );
    expect(bodyReads).toEqual([]);
  });

  it("sem If-None-Match, o acerto também não consulta o banco", async () => {
    await v2();
    h.calls.length = 0;
    const again = await v2();
    expect(again.status).toBe(200);
    expect(h.calls).toEqual([]);
  });

  it("status do agente, não lidas de e-mail e team-chat mudam: o ETag do v2 não muda", async () => {
    const etag = (await v2()).headers.get("etag");
    const v1Before = (await bootstrapGet(req("/api/me/bootstrap"))).headers.get("etag");

    h.tables.get("agentStatus")![0].status = "AWAY";
    h.emailAccounts[0].unreadCount = 7;
    h.roomsByOrg.set("org_a", [{ id: "r1", kind: "GROUP", name: "Geral A", unread: 3, muted: false, lastMessageAt: "2026-10-14T11:00:00.000Z", lastPreview: "oi" }]);

    h.calls.length = 0;
    const again = await v2(etag);
    expect(again.status).toBe(304);
    expect(h.calls).toEqual([]);
    // O v1 (frontend atual) continua mudando com os voláteis.
    const v1After = await bootstrapGet(req("/api/me/bootstrap", { "if-none-match": v1Before! }));
    expect(v1After.status).toBe(200);
  });

  describe("muda depois das escritas que alteram o estável", () => {
    it("editar o perfil (PUT /api/profile)", async () => {
      const etag = (await v2()).headers.get("etag");
      const put = await profilePut(
        new Request("https://api.test/api/profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ana Paula" }),
        }),
      );
      expect(put.status).toBe(200);
      const after = await v2(etag);
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(etag);
      expect(((await after.json()) as { profile: { name: string } }).profile.name).toBe("Ana Paula");
    });

    it("permissão/papel do usuário (invalidateAuthzForUser)", async () => {
      const etag = (await v2()).headers.get("etag");
      h.perms.set("org_a:u_a", ["deal:view", "deal:edit"]);
      await invalidateAuthzForUser("org_a", "u_a");
      const after = await v2(etag);
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(etag);
      const body = (await after.json()) as { effectivePermissions: { permissions: string[] } };
      expect(body.effectivePermissions.permissions).toEqual(["deal:view", "deal:edit"]);
    });

    it("departamento do usuário (addDepartmentMember)", async () => {
      const etag = (await v2()).headers.get("etag");
      await inOrg("org_a", "u_admin", () => addDepartmentMember("d1", "u_a"));
      // O Prisma falso não faz o upsert; a linha que o banco gravaria:
      h.tables.set("departmentMember", [{ userId: "u_a", organizationId: "org_a", departmentId: "d1" }]);
      const after = await v2(etag);
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(etag);
      const body = (await after.json()) as { alertConfig: { departmentIds: string[] } };
      expect(body.alertConfig.departmentIds).toEqual(["d1"]);
    });

    it("setting da org (setOrgSetting)", async () => {
      const etag = (await v2()).headers.get("etag");
      h.alertByOrg.set("org_a", { sound: false });
      await inOrg("org_a", "u_admin", () =>
        setOrgSetting("inbox.alerts.department.d1", JSON.stringify({ sound: false })),
      );
      const after = await v2(etag);
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(etag);
      const body = (await after.json()) as { alertConfig: { config: { sound: boolean } } };
      expect(body.alertConfig.config.sound).toBe(false);
    });
  });

  describe("isolamento", () => {
    it("usuário A / org A nunca recebe corpo nem 304 com o ETag de B / org B", async () => {
      asUser("org_b", "u_b");
      const b = await v2();
      const etagB = b.headers.get("etag");

      asUser("org_a", "u_a");
      const a = await v2(etagB);
      expect(a.status).toBe(200);
      expect(a.headers.get("etag")).not.toBe(etagB);
      const text = await a.text();
      expect(text).toContain("Org org_a");
      expect(text).not.toContain("Org org_b");
      expect(text).not.toContain("Bia");
    });

    it("mesmo id de usuário em orgs diferentes: entradas separadas", async () => {
      h.tables.get("user")!.push(
        { id: "u_x", organizationId: "org_a", name: "X na A", email: "x@a.test", role: "MEMBER", type: "HUMAN", isErased: false, isSuperAdmin: false, roleAssignments: [], agentStatus: null },
      );
      asUser("org_a", "u_x");
      const inA = await v2();
      const etagA = inA.headers.get("etag");

      // Mesmo id na org B (linha do banco da org B).
      h.tables.get("user")!.find((u) => u.id === "u_x")!.organizationId = "org_b";
      h.tables.get("user")!.find((u) => u.id === "u_x")!.name = "X na B";
      asUser("org_b", "u_x");
      h.calls.length = 0;
      const inB = await v2(etagA);
      expect(inB.status).toBe(200);
      expect(h.calls).toContain("user.findUnique"); // montou a entrada da org B
      const body = (await inB.json()) as { organization: { id: string }; profile: { name: string } };
      expect(body.organization.id).toBe("org_b");
      expect(body.profile.name).toBe("X na B");
      expect(inB.headers.get("etag")).not.toBe(etagA);
      const keys = [...h.redis.store.keys()].filter((k) => k.startsWith("cache:resp:me_boot:") && !k.endsWith(":etag"));
      expect(keys.some((k) => k.startsWith("cache:resp:me_boot:org_a:"))).toBe(true);
      expect(keys.some((k) => k.startsWith("cache:resp:me_boot:org_b:"))).toBe(true);
    });
  });

  describe("invalidação vista por outra réplica (versão lida do Redis)", () => {
    it("rc_me (por usuário): vale na próxima leitura", async () => {
      const etag = (await v2()).headers.get("etag");
      h.tables.get("user")!.find((u) => u.id === "u_a")!.name = "Ana (outra réplica)";
      bumpInRedisOnly("rc_me:org_a:u_a");
      const after = await v2(etag);
      expect(after.status).toBe(200);
      expect(((await after.json()) as { profile: { name: string } }).profile.name).toBe(
        "Ana (outra réplica)",
      );
    });

    it("famílias da org com memória local (authz): vale em ≤ 5 s", async () => {
      const etag = (await v2()).headers.get("etag");
      h.perms.set("org_a:u_a", ["*"]);
      bumpInRedisOnly("authz:org_a");
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
      const after = await v2(etag);
      expect(after.status).toBe(200);
      const body = (await after.json()) as { effectivePermissions: { permissions: string[] } };
      expect(body.effectivePermissions.permissions).toEqual(["*"]);
    });
  });

  it("bloco do estável que falhou não fica no cache", async () => {
    h.failPreferences = true;
    const first = await v2();
    expect(((await first.json()) as { failedBlocks: string[] }).failedBlocks).toEqual(["preferences"]);
    h.failPreferences = false;
    h.calls.length = 0;
    const second = await v2(first.headers.get("etag"));
    expect(second.status).toBe(200);
    expect(h.calls).toContain("getSidebarPreferenceBundle");
    expect(((await second.json()) as { failedBlocks: string[] }).failedBlocks).toEqual([]);
  });
});

describe("compatibilidade: sem o header continua a v1", () => {
  it("v1 traz os voláteis e todos os blocos (inclusive team-chat e departamentos)", async () => {
    const res = await bootstrapGet(req("/api/me/bootstrap"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { blocks: Record<string, unknown> };
    expect(body.version).toBe(1);
    for (const k of VOLATILE) expect(body).toHaveProperty(k);
    expect(Object.keys(body.blocks)).toEqual([...BOOTSTRAP_BLOCK_URLS]);
  });
});

describe("GET /api/me/live", () => {
  it("mesmo formato dos campos que saíram do v1, no-store, sem ETag", async () => {
    const v1 = (await (await bootstrapGet(req("/api/me/bootstrap"))).json()) as Record<string, unknown> & {
      blocks: Record<string, unknown>;
    };
    const res = await liveGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    const live = (await res.json()) as Record<string, unknown> & { blocks: Record<string, unknown> };

    expect(Object.keys(live)).toEqual([
      "version", "agentStatus", "emailUnread", "teamChatRooms", "usersPresence",
      "departmentCounts", "failedBlocks", "blocks", "blockErrors",
    ]);
    for (const k of VOLATILE) expect(live[k], k).toEqual(v1[k]);
    expect(live.agentStatus).toEqual({
      userId: "u_a",
      status: "ONLINE",
      availableForVoiceCalls: false,
      updatedAt: "2026-10-14T09:00:00.000Z",
    });
    expect(live.emailUnread).toEqual({ totalUnread: 0, accounts: [{ id: "e1", email: "caixa@a.test", unreadCount: 0 }] });
    expect(live.failedBlocks).toEqual([]);
    expect(Object.keys(live.blocks)).toEqual(["/api/team-chat/rooms", "/api/agents/u_a/status"]);
    expect(live.blocks["/api/team-chat/rooms"]).toEqual(v1.blocks["/api/team-chat/rooms"]);
    expect(live.blocks["/api/agents/u_a/status"]).toEqual(v1.agentStatus);
    expect(live.blockErrors).toEqual([]);
  });

  it("agente sem linha de status: fallback OFFLINE, como GET /api/agents/:id/status", async () => {
    h.tables.set("agentStatus", []);
    const live = (await (await liveGet()).json()) as { agentStatus: unknown };
    expect(live.agentStatus).toEqual({ userId: "u_a", status: "OFFLINE", availableForVoiceCalls: false });
  });
});

describe("v2 estável: /api/users e /api/settings/departments sem voláteis", () => {
  const USERS = "/api/users";
  const DEPTS = "/api/settings/departments";

  function asAdmin() {
    h.session.user = { ...h.session.user, role: "ADMIN" };
  }

  async function routeJson(handler: (r: Request) => Promise<Response>, path: string, v2Header: boolean) {
    const res = await handler(req(path, v2Header ? V2 : {}));
    expect(res.status, path).toBe(200);
    return (await res.json()) as Record<string, unknown>[];
  }

  it("com o header: users sem agentStatus/systemOnline/lastSeenAt; departamentos sem conversas abertas", async () => {
    asAdmin();
    const users = await routeJson(usersGet as (r: Request) => Promise<Response>, USERS, true);
    for (const u of users) {
      expect(u).not.toHaveProperty("agentStatus");
      expect(u).not.toHaveProperty("systemOnline");
      expect(u).not.toHaveProperty("lastSeenAt");
    }
    const depts = await routeJson(departmentsGet as (r: Request) => Promise<Response>, DEPTS, true);
    expect(depts.map((d) => d._count)).toEqual([{ members: 1 }, { members: 0 }]);

    // O bloco do bootstrap v2 é o MESMO corpo da rota com o header.
    const boot = (await (await v2()).json()) as { blocks: Record<string, unknown> };
    expect(boot.blocks[USERS]).toEqual(users);
    expect(boot.blocks[DEPTS]).toEqual(depts);
  });

  it("sem o header: as rotas continuam como hoje (compat com o frontend da main)", async () => {
    asAdmin();
    const users = await routeJson(usersGet as (r: Request) => Promise<Response>, USERS, false);
    const ana = users.find((u) => u.id === "u_a")!;
    expect(ana.systemOnline).toBe(true);
    expect(ana.lastSeenAt).toBe("2026-10-14T10:00:00.000Z");
    expect(ana.agentStatus).toEqual({ status: "ONLINE", availableForVoiceCalls: false, updatedAt: "2026-10-14T09:00:00.000Z" });
    const depts = await routeJson(departmentsGet as (r: Request) => Promise<Response>, DEPTS, false);
    expect(depts.map((d) => d._count)).toEqual([
      { conversations: 2, members: 1 },
      { conversations: 0, members: 0 },
    ]);
  });

  it("ETag do v2 não muda com status do agente, presença e conversas abertas", async () => {
    asAdmin();
    const etag = (await v2()).headers.get("etag");
    const usersVersion = h.redis.store.get("cache:v:rc_users:org_a")?.value;

    const put = await agentStatusPut(
      new Request("https://api.test/api/agents/u_a/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "AWAY" }),
      }),
      { params: Promise.resolve({ id: "u_a" }) },
    );
    expect(put.status).toBe(200);
    // Status de agente não sobe mais `rc_users`.
    expect(h.redis.store.get("cache:v:rc_users:org_a")?.value).toBe(usersVersion);

    h.presence.set("u_a", { systemOnline: false, lastSeenAt: new Date("2026-10-14T12:00:00.000Z") });
    h.tables.get("conversation")!.push({ id: "c4", organizationId: "org_a", status: "OPEN", departmentId: "d2" });
    h.tables.get("department")!.find((d) => d.id === "d2")!._count = { members: 0, conversations: 1 };
    // O que o inbox faz quando um ticket muda de aba.
    await bumpCacheVersion(cacheVersionName("inbox_tab_counts", "org_a"));

    h.calls.length = 0;
    const again = await v2(etag);
    expect(again.status).toBe(304);
    expect(h.calls).toEqual([]);

    // E o live mostra o que mudou.
    const live = (await (await liveGet()).json()) as {
      usersPresence: Record<string, { agentStatus: { status: string } | null; systemOnline: boolean }>;
      departmentCounts: Record<string, { openConversations: number }>;
    };
    expect(live.usersPresence.u_a.agentStatus?.status).toBe("AWAY");
    expect(live.usersPresence.u_a.systemOnline).toBe(false);
    expect(live.departmentCounts).toEqual({ d1: { openConversations: 2 }, d2: { openConversations: 1 } });
  });

  it("ETag do v2 muda ao editar usuário (PUT /api/users/:id)", async () => {
    asAdmin();
    const etag = (await v2()).headers.get("etag");
    const put = await userPut(
      new Request("https://api.test/api/users/u_a", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ana Maria" }),
      }),
      { params: Promise.resolve({ id: "u_a" }) },
    );
    expect(put.status).toBe(200);
    const after = await v2(etag);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const body = (await after.json()) as { blocks: Record<string, { id: string; name: string }[]> };
    expect(body.blocks[USERS].find((u) => u.id === "u_a")!.name).toBe("Ana Maria");
  });

  it("ETag do v2 muda ao editar departamento (PUT /api/settings/departments/:id)", async () => {
    asAdmin();
    const etag = (await v2()).headers.get("etag");
    const put = await departmentPut(
      new Request("https://api.test/api/settings/departments/d1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Atendimento" }),
      }),
      { params: Promise.resolve({ id: "d1" }) },
    );
    expect(put.status).toBe(200);
    const after = await v2(etag);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const body = (await after.json()) as { blocks: Record<string, { name: string }[]> };
    expect(body.blocks[DEPTS].map((d) => d.name)).toContain("Atendimento");
  });

  it("live: estável + usersPresence/departmentCounts reconstroem exatamente o corpo legado", async () => {
    asAdmin();
    h.tables.get("user")!.push(
      { id: "u_c", organizationId: "org_a", name: "Caio", email: "c@a.test", role: "MEMBER", type: "HUMAN", isErased: false, isSuperAdmin: false, roleAssignments: [] },
    );
    const live = (await (await liveGet()).json()) as {
      usersPresence: Record<string, unknown>;
      departmentCounts: Record<string, { openConversations: number }>;
    };
    expect(live.usersPresence.u_a).toEqual({
      systemOnline: true,
      lastSeenAt: "2026-10-14T10:00:00.000Z",
      agentStatus: { status: "ONLINE", availableForVoiceCalls: false, updatedAt: "2026-10-14T09:00:00.000Z" },
    });
    expect(live.usersPresence.u_c).toEqual(USER_PRESENCE_DEFAULT);
    // Só a org da sessão.
    expect(live.usersPresence).not.toHaveProperty("u_b");
    expect(live.departmentCounts).toEqual({ d1: { openConversations: 2 } });

    const stableUsers = await routeJson(usersGet as (r: Request) => Promise<Response>, USERS, true);
    const legacyUsers = await routeJson(usersGet as (r: Request) => Promise<Response>, USERS, false);
    const rebuiltUsers = stableUsers.map((u) => ({
      ...u,
      ...((live.usersPresence[u.id as string] as object | undefined) ?? USER_PRESENCE_DEFAULT),
    }));
    expect(rebuiltUsers).toEqual(legacyUsers);

    const stableDepts = await routeJson(departmentsGet as (r: Request) => Promise<Response>, DEPTS, true);
    const legacyDepts = await routeJson(departmentsGet as (r: Request) => Promise<Response>, DEPTS, false);
    const rebuiltDepts = stableDepts.map((d) => ({
      ...d,
      _count: {
        ...(d._count as object),
        conversations: live.departmentCounts[d.id as string]?.openConversations ?? 0,
      },
    }));
    expect(rebuiltDepts).toEqual(legacyDepts);
  });

  it("live: departmentCounts só para ADMIN/MANAGER; presença em cache (2ª chamada sem consulta)", async () => {
    const member = (await (await liveGet()).json()) as { departmentCounts: unknown; usersPresence: object };
    expect(member.departmentCounts).toBeNull();
    expect(member.usersPresence).toHaveProperty("u_a");

    h.calls.length = 0;
    await liveGet();
    expect(h.calls).not.toContain("getSystemPresenceMap");
    expect(h.calls).not.toContain("conversation.groupBy");
  });
});
