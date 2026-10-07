/**
 * `Server-Timing` nas rotas quentes do shell: GET /api/me/bootstrap,
 * GET /api/conversations (lista e counts=1), GET /api/channels,
 * GET /api/team-chat/rooms e GET /api/settings/org.
 *
 * Só instrumentação: o corpo e o status não mudam; o cabeçalho traz as fases
 * `auth`, `query`, `serialize` e `total` (e `checks` onde há checagem própria).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  buildMeBootstrap: vi.fn(),
  getChannels: vi.fn(),
  listRooms: vi.fn(),
  denyUnless: vi.fn(),
  getOrgSetting: vi.fn(),
  getOrgSettingsByPrefix: vi.fn(),
  getConversations: vi.fn(),
  getTabCounts: vi.fn(),
  role: "ADMIN" as "ADMIN" | "MEMBER",
}));

const session = () => ({
  user: { id: "u1", name: "Ana", email: "a@t.com", role: h.role, organizationId: "org_1", isSuperAdmin: false },
});

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (cb: (s: unknown) => unknown) => cb(session()),
  userOrgFilter: vi.fn(() => ({})),
}));
vi.mock("@/lib/api-auth", () => ({
  withApiAuthContext: async (_req: Request, cb: (u: unknown) => unknown) =>
    cb({ ...session().user, role: h.role }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/services/me-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/me-bootstrap")>();
  return {
    computeBootstrapEtag: actual.computeBootstrapEtag,
    etagMatches: actual.etagMatches,
    buildMeBootstrap: h.buildMeBootstrap,
  };
});
vi.mock("@/services/channels", () => ({
  getChannels: h.getChannels,
  createChannel: vi.fn(),
  parseInboxFilterChannelIds: vi.fn(),
}));
vi.mock("@/services/team-chat", () => ({ listRooms: h.listRooms, createRoom: vi.fn() }));
vi.mock("@/lib/api/guards", () => ({
  denyUnless: h.denyUnless,
  isServiceError: vi.fn(() => false),
  jsonError: vi.fn(),
  viewerOf: vi.fn(() => ({ userId: "u1" })),
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSetting: h.getOrgSetting,
  getOrgSettingsByPrefix: h.getOrgSettingsByPrefix,
  setOrgSetting: vi.fn(),
  deleteOrgSetting: vi.fn(),
}));
vi.mock("@/lib/authz/funnel-visibility", () => ({
  andConversationWhere: vi.fn((a: unknown) => a),
  conversationFunnelWhere: vi.fn(() => ({})),
  visibleStageIds: vi.fn((_a: unknown, ids: string[]) => ids),
}));
vi.mock("@/lib/authz/request-prechecks", () => ({
  authzContextOnce: vi.fn(async () => ({
    isAdmin: true,
    isSuperAdmin: false,
    permissions: new Set<string>(),
  })),
  scopeGrantsOnce: vi.fn(async () => ({})),
}));
vi.mock("@/lib/authz/scope-grants", () => ({ canSeeInboxTab: vi.fn(() => true) }));
vi.mock("@/lib/authz/resource-policy", () => ({ listAllowedChannelIds: vi.fn(async () => null) }));
vi.mock("@/lib/visibility", () => ({
  getVisibilityFilter: vi.fn(async () => ({
    canSeeAll: true,
    includeUnassigned: true,
    conversationWhere: {},
  })),
  withInboxQueueVisibility: vi.fn((w: unknown) => w),
}));
vi.mock("@/services/conversations", () => ({
  buildInboxFilterConditions: vi.fn(() => []),
  findSessionExpiringConversationIds: vi.fn(),
  getConversations: h.getConversations,
  getTabCounts: h.getTabCounts,
  INBOX_CATEGORY_TABS: ["esperando", "respondidas"],
  INBOX_TAB_LIST: ["esperando", "respondidas"],
  parseInboxTabParam: vi.fn(() => []),
}));

import { GET as bootstrapGet } from "@/app/api/me/bootstrap/route";
import { GET as channelsGet } from "@/app/api/channels/route";
import { GET as conversationsGet } from "@/app/api/conversations/route";
import { GET as orgSettingsGet } from "@/app/api/settings/org/route";
import { GET as roomsGet } from "@/app/api/team-chat/rooms/route";

/** `nome;dur=1.2;desc="x"` → { nome: { dur, desc } } */
function phases(header: string | null) {
  expect(header).toBeTruthy();
  const out: Record<string, { dur: number; desc?: string }> = {};
  for (const part of header!.split(", ")) {
    const m = /^([a-z]+);dur=([\d.]+)(?:;desc="([^"]*)")?$/.exec(part);
    expect(m, `fase mal formada: ${part}`).toBeTruthy();
    out[m![1]] = { dur: Number(m![2]), desc: m![3] };
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "ADMIN";
  h.denyUnless.mockResolvedValue(null);
});

describe("Server-Timing — rotas do shell", () => {
  it("GET /api/me/bootstrap: auth, query, serialize, total; 200 e 304 levam o cabeçalho", async () => {
    h.buildMeBootstrap.mockResolvedValue({ user: { id: "u1" } });

    const res = await bootstrapGet(new Request("https://api.test/api/me/bootstrap"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: "u1" } });
    expect(Object.keys(phases(res.headers.get("server-timing")))).toEqual([
      "auth",
      "query",
      "serialize",
      "total",
    ]);

    const etag = res.headers.get("etag")!;
    const cached = await bootstrapGet(
      new Request("https://api.test/api/me/bootstrap", { headers: { "if-none-match": etag } }),
    );
    expect(cached.status).toBe(304);
    expect(Object.keys(phases(cached.headers.get("server-timing")))).toContain("serialize");
  });

  it("GET /api/conversations (lista): checks, query[desc=list], serialize; corpo igual", async () => {
    h.getConversations.mockResolvedValue({ items: [{ id: "c1" }], total: 1 });

    const res = await conversationsGet(new Request("https://api.test/api/conversations?tab="));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: "c1" }], total: 1 });
    const p = phases(res.headers.get("server-timing"));
    expect(Object.keys(p)).toEqual(["auth", "checks", "query", "serialize", "total"]);
    expect(p.query.desc).toBe("list");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("GET /api/conversations?counts=1: query[desc=counts]", async () => {
    h.getTabCounts.mockResolvedValue({ esperando: 3, respondidas: 1 });

    const res = await conversationsGet(new Request("https://api.test/api/conversations?counts=1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ esperando: 3, respondidas: 1 });
    const p = phases(res.headers.get("server-timing"));
    expect(p.query.desc).toBe("counts");
    expect(Object.keys(p)).toEqual(["auth", "checks", "query", "serialize", "total"]);
  });

  it("GET /api/conversations?counts=1 de MEMBER (contadores mascarados) também leva o cabeçalho", async () => {
    h.role = "MEMBER";
    h.getTabCounts.mockResolvedValue({ esperando: 3, respondidas: 1, ligar: 2 });

    const res = await conversationsGet(new Request("https://api.test/api/conversations?counts=1"));

    expect(res.status).toBe(200);
    expect(phases(res.headers.get("server-timing")).serialize).toBeDefined();
  });

  it("GET /api/channels: auth, query, serialize, total", async () => {
    h.getChannels.mockResolvedValue([{ id: "ch1" }]);

    const res = await channelsGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channels: [{ id: "ch1" }] });
    expect(Object.keys(phases(res.headers.get("server-timing")))).toEqual([
      "auth",
      "query",
      "serialize",
      "total",
    ]);
  });

  it("GET /api/team-chat/rooms: auth, checks, query, serialize, total", async () => {
    h.listRooms.mockResolvedValue([{ id: "r1" }]);

    const res = await roomsGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: [{ id: "r1" }] });
    expect(Object.keys(phases(res.headers.get("server-timing")))).toEqual([
      "auth",
      "checks",
      "query",
      "serialize",
      "total",
    ]);
  });

  it("GET /api/team-chat/rooms negado: devolve a recusa sem consultar as salas", async () => {
    const denied = new Response(JSON.stringify({ message: "Acesso negado." }), { status: 403 });
    h.denyUnless.mockResolvedValue(denied);

    const res = await roomsGet();

    expect(res.status).toBe(403);
    expect(h.listRooms).not.toHaveBeenCalled();
  });

  it("GET /api/settings/org (key e prefix): auth, query, serialize, total; corpo igual", async () => {
    h.getOrgSetting.mockResolvedValue("1");
    const byKey = await orgSettingsGet(
      new Request("https://api.test/api/settings/org?key=conversation.keepAgentOnEnd"),
    );
    expect(byKey.status).toBe(200);
    expect(await byKey.json()).toEqual({ key: "conversation.keepAgentOnEnd", value: "1" });
    expect(Object.keys(phases(byKey.headers.get("server-timing")))).toEqual([
      "auth",
      "query",
      "serialize",
      "total",
    ]);

    h.getOrgSettingsByPrefix.mockResolvedValue(new Map([["conversation.a", "x"]]));
    const byPrefix = await orgSettingsGet(
      new Request("https://api.test/api/settings/org?prefix=conversation."),
    );
    expect(await byPrefix.json()).toEqual({ "conversation.a": "x" });
    expect(phases(byPrefix.headers.get("server-timing")).query).toBeDefined();
  });
});
