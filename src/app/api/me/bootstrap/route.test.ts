/**
 * GET /api/me/bootstrap — serializa o payload do serviço, manda ETag +
 * Cache-Control e responde 304 quando `If-None-Match` bate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withOrgContext: vi.fn(),
  buildMeBootstrap: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: mocks.withOrgContext,
  userOrgFilter: vi.fn(() => ({})),
}));

// O serviço importa `@/lib/prisma`/`prisma-base` (engine nativo não carrega
// nos testes desta máquina) — troca por stubs para manter o teste puro.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/authz", () => ({
  can: vi.fn(),
  loadAuthzContext: vi.fn(),
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/authz/resource-policy", () => ({ requirePermissionForUser: vi.fn() }));
vi.mock("@/lib/inbox-alert-config", () => ({
  DEFAULT_INBOX_ALERT_CONFIG: {},
  getEffectiveInboxAlertConfig: vi.fn(),
}));
vi.mock("@/services/email-accounts", () => ({
  resolveEmailAccess: vi.fn(),
  listEmailAccounts: vi.fn(),
}));
vi.mock("@/services/effective-permissions", () => ({
  computeEffectivePermissions: vi.fn(),
}));
vi.mock("@/services/organization-widgets", () => ({ getActiveWidgetSlugs: vi.fn() }));
vi.mock("@/services/team-chat", () => ({ listRooms: vi.fn() }));
vi.mock("@/services/user-preferences", () => ({
  computeAvailableKeys: vi.fn(),
  getSidebarPreferenceBundle: vi.fn(),
  getDashboardPreferences: vi.fn(),
  getAppearancePreferences: vi.fn(),
}));

vi.mock("@/services/me-bootstrap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/me-bootstrap")>();
  return {
    computeBootstrapEtag: actual.computeBootstrapEtag,
    etagMatches: actual.etagMatches,
    buildMeBootstrap: mocks.buildMeBootstrap,
  };
});

import { NextResponse } from "next/server";

import { GET } from "@/app/api/me/bootstrap/route";
import { computeBootstrapEtag } from "@/services/me-bootstrap";

const SESSION = {
  user: {
    id: "user_1",
    name: "Ana",
    email: "ana@test.com",
    role: "MEMBER",
    organizationId: "org_1",
    isSuperAdmin: false,
  },
};

const PAYLOAD = {
  version: 1,
  user: { id: "user_1", organizationId: "org_1", isSuperAdmin: false },
  profile: { id: "user_1", name: "Ana" },
  preferences: null,
  effectivePermissions: { permissions: ["deal:view"] },
  organization: { id: "org_1", slug: "org" },
  alertConfig: null,
  agentStatus: { userId: "user_1", status: "OFFLINE", availableForVoiceCalls: false },
  emailUnread: { totalUnread: 0, accounts: [] },
  teamChatRooms: null,
  widgets: { activeSlugs: [] },
  failedBlocks: [],
};

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/me/bootstrap", { headers });
}

describe("GET /api/me/bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withOrgContext.mockImplementation(async (handler: (s: typeof SESSION) => unknown) =>
      handler(SESSION),
    );
    mocks.buildMeBootstrap.mockResolvedValue(PAYLOAD);
  });

  it("devolve o payload com ETag e Cache-Control private, no-store", async () => {
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    const etag = res.headers.get("etag");
    expect(etag).toBe(computeBootstrapEtag(JSON.stringify(PAYLOAD)));
    expect(await res.json()).toEqual(PAYLOAD);
    expect(mocks.buildMeBootstrap).toHaveBeenCalledWith(SESSION.user);
  });

  it("responde 304 sem corpo quando If-None-Match bate", async () => {
    const first = await GET(req());
    const etag = first.headers.get("etag")!;

    const res = await GET(req({ "if-none-match": etag }));

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("");
  });

  it("responde 200 com corpo novo quando o payload mudou", async () => {
    const first = await GET(req());
    const etag = first.headers.get("etag")!;

    mocks.buildMeBootstrap.mockResolvedValue({
      ...PAYLOAD,
      emailUnread: { totalUnread: 2, accounts: [{ id: "a", email: "a@x", unreadCount: 2 }] },
    });
    const res = await GET(req({ "if-none-match": etag }));

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(etag);
    const body = await res.json();
    expect(body.emailUnread.totalUnread).toBe(2);
  });

  it("propaga a resposta de auth (401) sem montar o payload", async () => {
    mocks.withOrgContext.mockResolvedValue(
      NextResponse.json({ message: "Não autorizado." }, { status: 401 }),
    );

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(mocks.buildMeBootstrap).not.toHaveBeenCalled();
  });

  it("devolve 500 com mensagem quando o serviço lança", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.buildMeBootstrap.mockRejectedValue(new Error("db down"));

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "Erro ao carregar o bootstrap." });
  });
});
