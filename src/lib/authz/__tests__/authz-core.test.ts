/**
 * `lib/authz` — núcleo de permissões sem Postgres/Redis (CL-15).
 *
 * Cobre `can()` (bypass super-admin/ADMIN, wildcards), `loadAuthzContext`
 * (união de grants por papel, isolamento por org, fail-closed sem org,
 * fallback legado), o cache por org+usuário (`invalidateAuthzForUser` /
 * `invalidateAuthzForOrg`) e `requirePermission` (403 com `required`).
 *
 * O cache real (`@/lib/cache`) roda no fallback em memória (sem REDIS_URL).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    assignmentsFindMany: vi.fn().mockResolvedValue([] as unknown[]),
    userFindUnique: vi.fn().mockResolvedValue(null as { role: string } | null),
    roleFindFirst: vi.fn().mockResolvedValue(null as { permissions: string[] } | null),
  };
});

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    userRoleAssignment: { findMany: h.assignmentsFindMany },
    user: { findUnique: h.userFindUnique },
    role: { findFirst: h.roleFindFirst },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  type AuthzContext,
  can,
  canAll,
  canAny,
  canEditStage,
  canViewPipeline,
  canViewRoleField,
  canViewStage,
  invalidateAuthzForOrg,
  invalidateAuthzForUser,
  loadAuthzContext,
  requirePermission,
} from "@/lib/authz";
import { isValidPermissionKey } from "@/lib/authz/permissions";
import { MEMBER_PERMISSIONS } from "@/lib/authz/presets";

let userSeq = 0;
/** Usuário novo por teste — evita reaproveitar entrada de cache entre testes. */
function freshUser(): string {
  userSeq += 1;
  return `user-${userSeq}`;
}

function ctxWith(permissions: string[], extra: Partial<AuthzContext> = {}): AuthzContext {
  return {
    userId: "u",
    organizationId: "org-a",
    isSuperAdmin: false,
    isAdmin: false,
    permissions: new Set(permissions),
    stageView: null,
    stageDeny: new Set(),
    pipelineDeny: new Set(),
    stageEdit: null,
    fieldDenyView: new Set(),
    fieldDenyEdit: new Set(),
    sharedInbox: true,
    mediaAccess: true,
    seeTeam: false,
    seeUnassigned: false,
    ...extra,
  };
}

function roleAssignment(role: {
  systemPreset?: string | null;
  permissions?: string[];
  sharedInbox?: boolean;
  mediaAccess?: boolean;
  seeTeam?: boolean;
  seeUnassigned?: boolean;
  stageGrants?: { stageId: string; canView: boolean; canEdit: boolean }[];
  pipelineGrants?: { pipelineId: string; canView: boolean }[];
  fieldGrants?: { entity: string; fieldKey: string; canView: boolean; canEdit: boolean }[];
}) {
  return {
    role: {
      systemPreset: role.systemPreset ?? null,
      permissions: role.permissions ?? [],
      sharedInbox: role.sharedInbox ?? false,
      mediaAccess: role.mediaAccess ?? false,
      seeTeam: role.seeTeam ?? false,
      seeUnassigned: role.seeUnassigned ?? false,
      stageGrants: role.stageGrants ?? [],
      pipelineGrants: role.pipelineGrants ?? [],
      fieldGrants: role.fieldGrants ?? [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assignmentsFindMany.mockResolvedValue([]);
  h.userFindUnique.mockResolvedValue(null);
  h.roleFindFirst.mockResolvedValue(null);
});

describe("can()", () => {
  it("super-admin e preset ADMIN bypassam tudo, mesmo sem permissions", () => {
    expect(can(ctxWith([], { isSuperAdmin: true }), "pipeline:delete")).toBe(true);
    expect(can(ctxWith([], { isAdmin: true }), "pipeline:delete")).toBe(true);
  });

  it("chave exata, wildcard de recurso e '*'", () => {
    expect(can(ctxWith(["pipeline:view"]), "pipeline:view")).toBe(true);
    expect(can(ctxWith(["pipeline:view"]), "pipeline:edit")).toBe(false);
    expect(can(ctxWith(["pipeline:*"]), "pipeline:edit")).toBe(true);
    expect(can(ctxWith(["pipeline:*"]), "contact:view")).toBe(false);
    expect(can(ctxWith(["*"]), "contact:view")).toBe(true);
  });

  it("sem grants → false (fail-closed); canAll/canAny compõem", () => {
    const ctx = ctxWith(["contact:view"]);
    expect(can(ctx, "contact:create")).toBe(false);
    expect(canAll(ctx, ["contact:view", "contact:create"])).toBe(false);
    expect(canAny(ctx, ["contact:view", "contact:create"])).toBe(true);
  });
});

describe("loadAuthzContext — grants por papel", () => {
  it("consulta SÓ as atribuições do usuário NA org informada", async () => {
    const userId = freshUser();
    await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(1);
    const args = h.assignmentsFindMany.mock.calls[0]![0] as { where: unknown };
    expect(args.where).toEqual({ userId, organizationId: "org-a" });
  });

  it("une permissions de vários papéis, descarta chave inválida e marca ADMIN pelo preset", async () => {
    h.assignmentsFindMany.mockResolvedValue([
      roleAssignment({ permissions: ["pipeline:view", "nao:existe"] }),
      roleAssignment({ permissions: ["contact:view"], sharedInbox: true }),
    ]);
    const ctx = await loadAuthzContext({
      userId: freshUser(),
      organizationId: "org-a",
      isSuperAdmin: false,
    });
    expect([...ctx.permissions].sort()).toEqual(["contact:view", "pipeline:view"]);
    expect(ctx.isAdmin).toBe(false);
    expect(ctx.sharedInbox).toBe(true);
    expect(ctx.mediaAccess).toBe(false);
    expect(can(ctx, "pipeline:view")).toBe(true);
    expect(can(ctx, "pipeline:edit")).toBe(false);

    h.assignmentsFindMany.mockResolvedValue([
      roleAssignment({ systemPreset: "ADMIN", permissions: [] }),
    ]);
    const admin = await loadAuthzContext({
      userId: freshUser(),
      organizationId: "org-a",
      isSuperAdmin: false,
    });
    expect(admin.isAdmin).toBe(true);
    expect(can(admin, "pipeline:delete")).toBe(true);
  });

  it("etapas: deny explícito vence, só bloqueia se TODOS os papéis negam; edit allow-list", async () => {
    h.assignmentsFindMany.mockResolvedValue([
      roleAssignment({
        stageGrants: [
          { stageId: "s-hidden", canView: false, canEdit: false },
          { stageId: "s-edit", canView: true, canEdit: true },
        ],
      }),
      roleAssignment({
        stageGrants: [
          { stageId: "s-hidden", canView: false, canEdit: false },
          { stageId: "s-other", canView: false, canEdit: false },
        ],
      }),
    ]);
    const ctx = await loadAuthzContext({
      userId: freshUser(),
      organizationId: "org-a",
      isSuperAdmin: false,
    });
    expect(canViewStage(ctx, "s-hidden")).toBe(false);
    // negado por um papel só → continua visível
    expect(canViewStage(ctx, "s-other")).toBe(true);
    expect(canViewStage(ctx, "s-free")).toBe(true);
    expect(canEditStage(ctx, "s-hidden")).toBe(false);
    expect(canEditStage(ctx, "s-edit")).toBe(true);
  });

  it("funil negado e campo negado (deny vence entre papéis)", async () => {
    h.assignmentsFindMany.mockResolvedValue([
      roleAssignment({
        pipelineGrants: [{ pipelineId: "p-x", canView: false }],
        fieldGrants: [{ entity: "deal", fieldKey: "value", canView: false, canEdit: true }],
      }),
      roleAssignment({
        pipelineGrants: [{ pipelineId: "p-x", canView: false }],
        fieldGrants: [{ entity: "deal", fieldKey: "value", canView: true, canEdit: true }],
      }),
    ]);
    const ctx = await loadAuthzContext({
      userId: freshUser(),
      organizationId: "org-a",
      isSuperAdmin: false,
    });
    expect(canViewPipeline(ctx, "p-x")).toBe(false);
    expect(canViewPipeline(ctx, "p-y")).toBe(true);
    expect(canViewRoleField(ctx, "deal", "value")).toBe(false);
    expect(canViewRoleField(ctx, "deal", "title")).toBe(true);
  });

  it("super-admin não toca no banco; usuário sem org é fail-closed", async () => {
    const sa = await loadAuthzContext({ userId: "sa", organizationId: null, isSuperAdmin: true });
    expect(sa.isSuperAdmin).toBe(true);
    expect(h.assignmentsFindMany).not.toHaveBeenCalled();

    const semOrg = await loadAuthzContext({
      userId: freshUser(),
      organizationId: null,
      isSuperAdmin: false,
    });
    expect(semOrg.isAdmin).toBe(false);
    expect(semOrg.permissions.size).toBe(0);
    expect(can(semOrg, "contact:view")).toBe(false);
    expect(h.assignmentsFindMany).not.toHaveBeenCalled();
  });

  it("fallback legado: sem atribuições usa User.role + preset da org (ou constante)", async () => {
    h.userFindUnique.mockResolvedValue({ role: "MEMBER" });
    const member = await loadAuthzContext({
      userId: freshUser(),
      organizationId: "org-a",
      isSuperAdmin: false,
    });
    // O fallback filtra por `isValidPermissionKey`: chave de preset fora do
    // catálogo (hoje `quota:view`) é descartada — por isso o filtro aqui.
    expect([...member.permissions].sort()).toEqual(
      [...MEMBER_PERMISSIONS].filter(isValidPermissionKey).sort(),
    );
    expect(member.permissions.size).toBeGreaterThan(0);
    expect(h.roleFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-a", systemPreset: "MEMBER" } }),
    );

    h.userFindUnique.mockResolvedValue({ role: "ADMIN" });
    const admin = await loadAuthzContext({
      userId: freshUser(),
      organizationId: "org-a",
      isSuperAdmin: false,
    });
    expect(admin.isAdmin).toBe(true);
  });
});

describe("cache de authz", () => {
  it("segunda carga do mesmo usuário/org não vai ao banco; invalidateAuthzForUser força recarga", async () => {
    const userId = freshUser();
    h.assignmentsFindMany.mockResolvedValue([roleAssignment({ permissions: ["contact:view"] })]);

    const a = await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    const b = await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(1);
    expect(can(a, "contact:view")).toBe(true);
    expect(can(b, "contact:view")).toBe(true);

    // papel mudou no banco, cache ainda serve o antigo
    h.assignmentsFindMany.mockResolvedValue([roleAssignment({ permissions: ["pipeline:view"] })]);
    const stale = await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    expect(can(stale, "contact:view")).toBe(true);
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(1);

    await invalidateAuthzForUser("org-a", userId);
    const fresh = await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(2);
    expect(can(fresh, "contact:view")).toBe(false);
    expect(can(fresh, "pipeline:view")).toBe(true);
  });

  it("cache é por org: o mesmo usuário em outra org recarrega e não herda grants", async () => {
    const userId = freshUser();
    h.assignmentsFindMany.mockResolvedValueOnce([roleAssignment({ permissions: ["contact:view"] })]);
    const orgA = await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    expect(can(orgA, "contact:view")).toBe(true);

    h.assignmentsFindMany.mockResolvedValueOnce([]);
    const orgB = await loadAuthzContext({ userId, organizationId: "org-b", isSuperAdmin: false });
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(2);
    expect((h.assignmentsFindMany.mock.calls[1]![0] as { where: { organizationId: string } }).where.organizationId).toBe("org-b");
    expect(can(orgB, "contact:view")).toBe(false);
  });

  it("invalidateAuthzForUser em outra org não derruba o cache desta", async () => {
    const userId = freshUser();
    h.assignmentsFindMany.mockResolvedValue([roleAssignment({ permissions: ["contact:view"] })]);
    await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    await invalidateAuthzForUser("org-b", userId);
    await loadAuthzContext({ userId, organizationId: "org-a", isSuperAdmin: false });
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(1);
  });

  it("invalidateAuthzForOrg limpa todos os usuários da org (e só dela)", async () => {
    const u1 = freshUser();
    const u2 = freshUser();
    h.assignmentsFindMany.mockResolvedValue([roleAssignment({ permissions: ["contact:view"] })]);
    await loadAuthzContext({ userId: u1, organizationId: "org-a", isSuperAdmin: false });
    await loadAuthzContext({ userId: u2, organizationId: "org-a", isSuperAdmin: false });
    await loadAuthzContext({ userId: u1, organizationId: "org-c", isSuperAdmin: false });
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(3);

    await invalidateAuthzForOrg("org-a");
    await loadAuthzContext({ userId: u1, organizationId: "org-a", isSuperAdmin: false });
    await loadAuthzContext({ userId: u2, organizationId: "org-a", isSuperAdmin: false });
    await loadAuthzContext({ userId: u1, organizationId: "org-c", isSuperAdmin: false });
    // org-a recarregou (2), org-c continuou em cache
    expect(h.assignmentsFindMany).toHaveBeenCalledTimes(5);
  });
});

describe("requirePermission", () => {
  it("negado → 403 com `required`; permitido → null", async () => {
    const userId = freshUser();
    h.assignmentsFindMany.mockResolvedValue([roleAssignment({ permissions: ["contact:view"] })]);
    const user = { id: userId, organizationId: "org-a", isSuperAdmin: false };

    const denied = await requirePermission(user, "pipeline:edit");
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
    await expect(denied!.json()).resolves.toEqual({
      message: "Acesso negado.",
      required: "pipeline:edit",
    });

    expect(await requirePermission(user, "contact:view")).toBeNull();
  });

  it("super-admin nunca é negado", async () => {
    const ok = await requirePermission(
      { id: "sa", organizationId: null, isSuperAdmin: true },
      "pipeline:delete",
    );
    expect(ok).toBeNull();
  });
});
