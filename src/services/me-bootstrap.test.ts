/**
 * services/me-bootstrap — monta os blocos com serviços mockados, respeita
 * a permissão por bloco (null quando negado) e isola falhas por bloco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  orgFindUnique: vi.fn(),
  departmentMemberFindMany: vi.fn(),
  agentStatusFindUnique: vi.fn(),
  baseUserFindFirst: vi.fn(),
  loadAuthzContext: vi.fn(),
  can: vi.fn(),
  requirePermission: vi.fn(),
  requirePermissionForUser: vi.fn(),
  getEffectiveInboxAlertConfig: vi.fn(),
  resolveEmailAccess: vi.fn(),
  listEmailAccounts: vi.fn(),
  computeEffectivePermissions: vi.fn(),
  getActiveWidgetSlugs: vi.fn(),
  listRooms: vi.fn(),
  getSidebarPreferenceBundle: vi.fn(),
  getDashboardPreferences: vi.fn(),
  getAppearancePreferences: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    organization: { findUnique: mocks.orgFindUnique },
    departmentMember: { findMany: mocks.departmentMemberFindMany },
    agentStatus: { findUnique: mocks.agentStatusFindUnique },
  },
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findFirst: mocks.baseUserFindFirst } },
}));

vi.mock("@/lib/auth-helpers", () => ({
  userOrgFilter: (s: { user: { organizationId: string | null; isSuperAdmin: boolean } }) =>
    s.user.organizationId
      ? { organizationId: s.user.organizationId }
      : s.user.isSuperAdmin
        ? {}
        : { organizationId: "__none__" },
}));

vi.mock("@/lib/authz", () => ({
  loadAuthzContext: mocks.loadAuthzContext,
  can: mocks.can,
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/lib/authz/resource-policy", () => ({
  requirePermissionForUser: mocks.requirePermissionForUser,
}));

vi.mock("@/lib/inbox-alert-config", () => ({
  DEFAULT_INBOX_ALERT_CONFIG: { mine: {}, queue: {}, others: {} },
  getEffectiveInboxAlertConfig: mocks.getEffectiveInboxAlertConfig,
}));

vi.mock("@/services/email-accounts", () => ({
  resolveEmailAccess: mocks.resolveEmailAccess,
  listEmailAccounts: mocks.listEmailAccounts,
}));

vi.mock("@/services/effective-permissions", () => ({
  computeEffectivePermissions: mocks.computeEffectivePermissions,
}));

vi.mock("@/services/organization-widgets", () => ({
  getActiveWidgetSlugs: mocks.getActiveWidgetSlugs,
}));

vi.mock("@/services/team-chat", () => ({
  listRooms: mocks.listRooms,
}));

vi.mock("@/services/user-preferences", () => ({
  computeAvailableKeys: (
    canFn: (k: string) => boolean,
    widgetFn: (s: string) => boolean,
  ) => {
    const keys = new Set<string>();
    if (canFn("deal:view")) keys.add("pipeline");
    if (widgetFn("softphone")) keys.add("softphone");
    return keys;
  },
  getSidebarPreferenceBundle: mocks.getSidebarPreferenceBundle,
  getDashboardPreferences: mocks.getDashboardPreferences,
  getAppearancePreferences: mocks.getAppearancePreferences,
}));

import {
  buildMeBootstrap,
  computeBootstrapEtag,
  etagMatches,
} from "@/services/me-bootstrap";

const USER = {
  id: "user_1",
  name: "Ana",
  email: "ana@test.com",
  role: "MEMBER" as const,
  organizationId: "org_1",
  isSuperAdmin: false,
};

const PROFILE_ROW = {
  id: "user_1",
  name: "Ana",
  email: "ana@test.com",
  role: "MEMBER",
  avatarUrl: null,
  phone: null,
  signature: null,
  closingMessage: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  chatTheme: "azul",
};

function armHappyPath() {
  mocks.userFindUnique.mockResolvedValue(PROFILE_ROW);
  mocks.orgFindUnique.mockResolvedValue({
    id: "org_1",
    name: "Org",
    slug: "org",
    logoUrl: null,
    primaryColor: "#000",
    status: "ACTIVE",
    onboardingCompletedAt: null,
  });
  mocks.departmentMemberFindMany.mockResolvedValue([{ departmentId: "dep_1" }]);
  mocks.agentStatusFindUnique.mockResolvedValue(null);
  mocks.baseUserFindFirst.mockResolvedValue({
    id: "user_1",
    role: "MEMBER",
    organizationId: "org_1",
    isSuperAdmin: false,
  });
  mocks.loadAuthzContext.mockResolvedValue({ permissions: new Set(["deal:view"]) });
  mocks.can.mockImplementation((_ctx: unknown, key: string) => key === "deal:view");
  mocks.requirePermission.mockResolvedValue(null);
  mocks.requirePermissionForUser.mockResolvedValue(null);
  mocks.getEffectiveInboxAlertConfig.mockResolvedValue({ mine: { sound: true } });
  mocks.resolveEmailAccess.mockResolvedValue({
    userId: "user_1",
    canViewShared: false,
    canViewOwn: true,
    canConnect: false,
  });
  mocks.listEmailAccounts.mockResolvedValue([
    { id: "acc_1", email: "a@x.com", unreadCount: 3, imapHost: "x" },
    { id: "acc_2", email: "b@x.com", unreadCount: 2, imapHost: "y" },
  ]);
  mocks.computeEffectivePermissions.mockResolvedValue({
    permissions: ["deal:view"],
    channelGrants: [],
    stageGrants: [],
    roles: [],
    groups: [],
  });
  mocks.getActiveWidgetSlugs.mockResolvedValue(new Set(["softphone", "calls"]));
  mocks.listRooms.mockResolvedValue([
    {
      id: "room_1",
      kind: "DM",
      name: "Bruno",
      unread: 4,
      muted: false,
      lastMessageAt: "2026-01-02T00:00:00.000Z",
      lastPreview: "oi",
      members: [{ id: "u2" }],
      peer: { id: "u2" },
    },
    {
      id: "room_2",
      kind: "GROUP",
      name: "Time",
      unread: 9,
      muted: true,
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      lastPreview: null,
      members: [],
      peer: null,
    },
  ]);
  mocks.getSidebarPreferenceBundle.mockResolvedValue({
    sidebar: { items: [] },
    roleSidebar: null,
  });
  mocks.getDashboardPreferences.mockResolvedValue({ blocks: [] });
  mocks.getAppearancePreferences.mockResolvedValue({ theme: "light" });
}

describe("buildMeBootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    armHappyPath();
  });

  it("monta todos os blocos a partir dos serviços de cada rota", async () => {
    const out = await buildMeBootstrap(USER);

    expect(out.version).toBe(1);
    expect(out.user).toEqual({ id: "user_1", organizationId: "org_1", isSuperAdmin: false });
    expect(out.profile).toEqual(PROFILE_ROW);
    expect(out.organization?.slug).toBe("org");
    expect(out.alertConfig).toEqual({
      config: { mine: { sound: true } },
      departmentIds: ["dep_1"],
    });
    expect(out.agentStatus).toEqual({
      userId: "user_1",
      status: "OFFLINE",
      availableForVoiceCalls: false,
    });
    expect(out.effectivePermissions?.permissions).toEqual(["deal:view"]);
    expect(mocks.computeEffectivePermissions).toHaveBeenCalledWith({
      id: "user_1",
      role: "MEMBER",
      organizationId: "org_1",
      isSuperAdmin: false,
    });

    // e-mail: só id/e-mail/unreadCount, sem hosts/credenciais
    expect(out.emailUnread).toEqual({
      totalUnread: 5,
      accounts: [
        { id: "acc_1", email: "a@x.com", unreadCount: 3 },
        { id: "acc_2", email: "b@x.com", unreadCount: 2 },
      ],
    });

    // team-chat: resumo por sala; sala silenciada não conta no total
    expect(out.teamChatRooms?.totalUnread).toBe(4);
    expect(out.teamChatRooms?.rooms).toEqual([
      {
        id: "room_1",
        kind: "DM",
        name: "Bruno",
        unread: 4,
        muted: false,
        lastMessageAt: "2026-01-02T00:00:00.000Z",
        lastPreview: "oi",
      },
      {
        id: "room_2",
        kind: "GROUP",
        name: "Time",
        unread: 9,
        muted: true,
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        lastPreview: null,
      },
    ]);
    expect(out.teamChatRooms?.rooms[0]).not.toHaveProperty("members");

    // widgets: slugs ordenados; uma consulta só alimenta widgets + preferências
    expect(out.widgets).toEqual({ activeSlugs: ["calls", "softphone"] });
    expect(mocks.getActiveWidgetSlugs).toHaveBeenCalledTimes(1);
    expect(out.preferences?.availableKeys).toEqual(["pipeline", "softphone"]);
    expect(mocks.getSidebarPreferenceBundle).toHaveBeenCalledWith(
      "user_1",
      new Set(["pipeline", "softphone"]),
    );

    expect(out.failedBlocks).toEqual([]);
  });

  it("devolve null no bloco de e-mail quando o usuário não tem permissão", async () => {
    mocks.resolveEmailAccess.mockResolvedValue({
      userId: "user_1",
      canViewShared: false,
      canViewOwn: false,
      canConnect: false,
    });
    mocks.requirePermission.mockResolvedValue({ status: 403 });

    const out = await buildMeBootstrap(USER);

    expect(out.emailUnread).toBeNull();
    expect(mocks.requirePermission).toHaveBeenCalledWith(USER, "email_account:view");
    expect(mocks.listEmailAccounts).not.toHaveBeenCalled();
    expect(out.failedBlocks).toEqual([]);
  });

  it("devolve null nas salas do team-chat quando team_chat:view é negado", async () => {
    mocks.requirePermissionForUser.mockResolvedValue({ status: 403 });

    const out = await buildMeBootstrap(USER);

    expect(out.teamChatRooms).toBeNull();
    expect(mocks.requirePermissionForUser).toHaveBeenCalledWith(
      { id: "user_1", role: "MEMBER", organizationId: "org_1", isSuperAdmin: false },
      "team_chat:view",
    );
    expect(mocks.listRooms).not.toHaveBeenCalled();
    expect(out.failedBlocks).toEqual([]);
  });

  it("super-admin sem org: organização/salas/widgets nulos ou vazios, alert-config default", async () => {
    const out = await buildMeBootstrap({ ...USER, organizationId: null, isSuperAdmin: true });

    expect(out.organization).toBeNull();
    expect(out.teamChatRooms).toBeNull();
    expect(out.widgets).toEqual({ activeSlugs: [] });
    expect(out.alertConfig).toEqual({
      config: { mine: {}, queue: {}, others: {} },
      departmentIds: [],
    });
    expect(mocks.getActiveWidgetSlugs).not.toHaveBeenCalled();
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it("isola falha de um bloco: null + failedBlocks, os outros seguem", async () => {
    mocks.listRooms.mockRejectedValue(new Error("boom"));
    mocks.getActiveWidgetSlugs.mockRejectedValue(new Error("widgets down"));

    const out = await buildMeBootstrap(USER);

    expect(out.teamChatRooms).toBeNull();
    expect(out.widgets).toBeNull();
    expect(out.failedBlocks).toEqual(["teamChatRooms", "widgets"]);
    expect(out.profile).toEqual(PROFILE_ROW);
    // preferências ainda montam, sem widgets
    expect(out.preferences?.availableKeys).toEqual(["pipeline"]);
  });

  it("cai no select sem chatTheme quando a coluna não existe", async () => {
    mocks.userFindUnique
      .mockRejectedValueOnce(new Error('column "chatTheme" does not exist'))
      .mockResolvedValueOnce({ ...PROFILE_ROW, chatTheme: undefined });

    const out = await buildMeBootstrap(USER);

    expect(out.profile?.chatTheme).toBe("azul");
    expect(out.failedBlocks).toEqual([]);
  });
});

describe("ETag", () => {
  it("é estável para o mesmo corpo e muda quando o corpo muda", () => {
    const a = computeBootstrapEtag('{"a":1}');
    expect(a).toBe(computeBootstrapEtag('{"a":1}'));
    expect(a).not.toBe(computeBootstrapEtag('{"a":2}'));
    expect(a).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("etagMatches aceita valor exato, lista e prefixo fraco", () => {
    const etag = '"abc"';
    expect(etagMatches('"abc"', etag)).toBe(true);
    expect(etagMatches('W/"abc"', etag)).toBe(true);
    expect(etagMatches('"x", "abc"', etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches('"xyz"', etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
  });
});
