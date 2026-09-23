import { Prisma } from "@prisma/client";

import { invalidateAuthzForOrg } from "@/lib/authz";
import { sanitizePermissions } from "@/lib/authz/permissions";
import {
  ensureSystemPresetRoles,
  syncMissingUserRoleAssignments,
} from "@/lib/authz/sync-user-role";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import {
  normalizeSidebar,
  type SidebarItemPreference,
} from "@/services/user-preferences";

export type RoleStageGrantInput = {
  stageId: string;
  canView: boolean;
  canEdit: boolean;
};
export type RolePipelineGrantInput = {
  pipelineId: string;
  canView: boolean;
};
export type RoleFieldGrantInput = {
  entity: string;
  fieldKey: string;
  canView: boolean;
  canEdit: boolean;
};

const roleListSelect = {
  id: true,
  name: true,
  description: true,
  systemPreset: true,
  isSystem: true,
  permissions: true,
  inheritsFrom: true,
  sidebarItems: true,
  sharedInbox: true,
  mediaAccess: true,
  _count: { select: { assignments: true } },
} satisfies Prisma.RoleSelect;

const roleDetailSelect = {
  ...roleListSelect,
  assignments: {
    select: {
      id: true,
      user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
  stageGrants: {
    select: { stageId: true, canView: true, canEdit: true },
  },
  pipelineGrants: {
    select: { pipelineId: true, canView: true },
  },
  fieldGrants: {
    select: { entity: true, fieldKey: true, canView: true, canEdit: true },
  },
} satisfies Prisma.RoleSelect;

/**
 * Mantém allow (view/edit) e bloqueio explícito (view e edit falsos).
 * Editar implica ver. Array vazio = papel sem restrição de etapa.
 */
function sanitizeStageGrants(
  input: RoleStageGrantInput[] | undefined | null,
): RoleStageGrantInput[] {
  if (!input) return [];
  const byStage = new Map<string, RoleStageGrantInput>();
  for (const g of input) {
    const stageId = g.stageId?.trim();
    if (!stageId) continue;
    const canEdit = !!g.canEdit;
    const canView = canEdit ? true : !!g.canView;
    byStage.set(stageId, { stageId, canView, canEdit });
  }
  return Array.from(byStage.values());
}

/** Só persiste bloqueio de funil. `canView: true` é o default e não vira linha. */
function sanitizePipelineGrants(
  input: RolePipelineGrantInput[] | undefined | null,
): RolePipelineGrantInput[] {
  if (!input) return [];
  const byPipeline = new Map<string, RolePipelineGrantInput>();
  for (const g of input) {
    const pipelineId = g.pipelineId?.trim();
    if (!pipelineId || g.canView) continue;
    byPipeline.set(pipelineId, { pipelineId, canView: false });
  }
  return Array.from(byPipeline.values());
}

/** Filtra grants de campo: mantem só regras que restringem algo. */
function sanitizeFieldGrants(
  input: RoleFieldGrantInput[] | undefined | null,
): RoleFieldGrantInput[] {
  if (!input) return [];
  const byKey = new Map<string, RoleFieldGrantInput>();
  for (const g of input) {
    const entity = g.entity?.trim();
    const fieldKey = g.fieldKey?.trim();
    if (!entity || !fieldKey) continue;
    byKey.set(`${entity}.${fieldKey}`, {
      entity,
      fieldKey,
      canView: !!g.canView,
      canEdit: !!g.canEdit,
    });
  }
  return Array.from(byKey.values());
}

function extractSidebarItems(raw: unknown): SidebarItemPreference[] | null {
  if (!raw) return null;
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: SidebarItemPreference[] }).items
      : null;
  return items as SidebarItemPreference[] | null;
}

function mapRoleList(
  row: Prisma.RoleGetPayload<{ select: typeof roleListSelect }>,
) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPreset: row.systemPreset,
    isSystem: row.isSystem,
    permissions: row.permissions,
    inheritsFrom: row.inheritsFrom,
    // `null` = papel usa o catalogo padrao (sem override).
    sidebarItems: extractSidebarItems(row.sidebarItems),
    sharedInbox: row.sharedInbox,
    mediaAccess: row.mediaAccess,
    _count: {
      assignments: row._count.assignments,
      groups: 0,
      groupMembers: 0,
    },
  };
}

function mapRoleDetail(
  row: Prisma.RoleGetPayload<{ select: typeof roleDetailSelect }>,
) {
  return {
    ...mapRoleList(row),
    assignments: row.assignments.map((a) => ({
      id: a.id,
      user: a.user,
    })),
    stageGrants: row.stageGrants.map((g) => ({
      stageId: g.stageId,
      canView: g.canView,
      canEdit: g.canEdit,
    })),
    pipelineGrants: row.pipelineGrants.map((g) => ({
      pipelineId: g.pipelineId,
      canView: g.canView,
    })),
    fieldGrants: row.fieldGrants.map((g) => ({
      entity: g.entity,
      fieldKey: g.fieldKey,
      canView: g.canView,
      canEdit: g.canEdit,
    })),
  };
}

/** Lista roles da org. Auto-cura presets ausentes (orgs criadas pós-migration). */
export async function listRoles() {
  const orgId = getOrgIdOrThrow();
  await prisma.$transaction(async (tx) => {
    await ensureSystemPresetRoles(tx, orgId);
    await syncMissingUserRoleAssignments(tx, orgId);
  });

  const rows = await prisma.role.findMany({
    where: { organizationId: orgId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    select: roleListSelect,
  });
  return rows.map(mapRoleList);
}

export async function getRoleById(id: string) {
  const orgId = getOrgIdOrThrow();
  const row = await prisma.role.findFirst({
    where: { id, organizationId: orgId },
    select: roleDetailSelect,
  });
  return row ? mapRoleDetail(row) : null;
}

/**
 * Valida o ponteiro de heranca: precisa ser um Role existente na MESMA org
 * (ou null). Evita apontar pra role de outro tenant ou pra id inexistente.
 * `selfId` impede um grupo de herdar de si mesmo (no update).
 */
async function resolveInheritsFrom(
  orgId: string,
  value: string | null | undefined,
  selfId?: string,
): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const baseId = value.trim();
  if (!baseId) return null;
  if (selfId && baseId === selfId) {
    throw new Error("Um grupo não pode herdar de si mesmo.");
  }
  const base = await prisma.role.findFirst({
    where: { id: baseId, organizationId: orgId },
    select: { id: true },
  });
  if (!base) throw new Error("Grupo de origem (herança) não encontrado.");
  return base.id;
}

export async function createRole(input: {
  name: string;
  description?: string | null;
  permissions: string[];
  inheritsFrom?: string | null;
  sidebarItems?: SidebarItemPreference[] | null;
  sharedInbox?: boolean;
  mediaAccess?: boolean;
  stageGrants?: RoleStageGrantInput[] | null;
  pipelineGrants?: RolePipelineGrantInput[] | null;
  fieldGrants?: RoleFieldGrantInput[] | null;
}) {
  const orgId = getOrgIdOrThrow();
  const name = input.name.trim();
  if (!name) throw new Error("Nome é obrigatório.");

  const permissions = sanitizePermissions(input.permissions);
  const inheritsFrom = await resolveInheritsFrom(orgId, input.inheritsFrom);
  const stageGrants = sanitizeStageGrants(input.stageGrants);
  const pipelineGrants = sanitizePipelineGrants(input.pipelineGrants);
  const fieldGrants = sanitizeFieldGrants(input.fieldGrants);

  // sidebarItems: undefined => nao salva override (usa catalogo padrao).
  // null explicito ou array vazio => tambem trata como "sem override"
  // (semantica igual ao delete). Array com items => normaliza + salva.
  let sidebarJson: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined;
  if (input.sidebarItems === undefined) {
    sidebarJson = undefined;
  } else if (input.sidebarItems === null || input.sidebarItems.length === 0) {
    sidebarJson = Prisma.JsonNull;
  } else {
    const normalized = normalizeSidebar(input.sidebarItems);
    sidebarJson = normalized as unknown as Prisma.InputJsonValue;
  }

  const role = await prisma.role.create({
    data: {
      organizationId: orgId,
      name,
      description: input.description?.trim() || null,
      permissions,
      inheritsFrom: inheritsFrom ?? null,
      isSystem: false,
      systemPreset: null,
      ...(input.sharedInbox !== undefined ? { sharedInbox: input.sharedInbox } : {}),
      ...(input.mediaAccess !== undefined ? { mediaAccess: input.mediaAccess } : {}),
      ...(sidebarJson !== undefined ? { sidebarItems: sidebarJson } : {}),
      stageGrants: {
        create: stageGrants.map((g) => ({ organizationId: orgId, ...g })),
      },
      pipelineGrants: {
        create: pipelineGrants.map((g) => ({ organizationId: orgId, ...g })),
      },
      fieldGrants: {
        create: fieldGrants.map((g) => ({ organizationId: orgId, ...g })),
      },
    },
    select: roleDetailSelect,
  });
  return mapRoleDetail(role);
}

export async function updateRole(
  id: string,
  input: {
    name?: string;
    description?: string | null;
    permissions?: string[];
    inheritsFrom?: string | null;
    sidebarItems?: SidebarItemPreference[] | null;
    sharedInbox?: boolean;
    mediaAccess?: boolean;
    stageGrants?: RoleStageGrantInput[] | null;
    pipelineGrants?: RolePipelineGrantInput[] | null;
    fieldGrants?: RoleFieldGrantInput[] | null;
  },
) {
  const orgId = getOrgIdOrThrow();
  const existing = await prisma.role.findFirst({
    where: { id, organizationId: orgId },
    select: { id: true, isSystem: true, systemPreset: true, permissions: true },
  });
  if (!existing) return null;

  const data: Prisma.RoleUpdateInput = {};

  if (!existing.isSystem) {
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error("Nome é obrigatório.");
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = input.description?.trim() || null;
    }
    // Troca de origem de heranca so faz sentido em grupos custom.
    if (input.inheritsFrom !== undefined) {
      data.inheritsFrom = await resolveInheritsFrom(
        orgId,
        input.inheritsFrom,
        id,
      );
    }
  }

  if (input.permissions !== undefined) {
    let permissions = sanitizePermissions(input.permissions);
    // Preset ADMIN sempre mantém wildcard — kill switch do authz.
    if (existing.systemPreset === "ADMIN") {
      permissions = ["*"];
    } else if (permissions.length === 0) {
      throw new Error("O role precisa ter ao menos uma permissão.");
    }
    data.permissions = permissions;
  }

  // sidebarItems editavel em qualquer papel (inclusive presets do sistema)
  // — as permissoes de conteudo dele sao imutaveis, mas o "menu lateral"
  // dos usuarios daquele papel e' operacional. null/vazio == remove override.
  if (input.sidebarItems !== undefined) {
    if (input.sidebarItems === null || input.sidebarItems.length === 0) {
      data.sidebarItems = Prisma.JsonNull;
    } else {
      const normalized = normalizeSidebar(input.sidebarItems);
      data.sidebarItems = normalized as unknown as Prisma.InputJsonValue;
    }
  }

  // Extras + grants: operacionais, editaveis inclusive em presets do sistema
  // (ADMIN bypassa enforcement de qualquer forma). Substitui a lista inteira.
  if (input.sharedInbox !== undefined) data.sharedInbox = input.sharedInbox;
  if (input.mediaAccess !== undefined) data.mediaAccess = input.mediaAccess;
  if (input.stageGrants !== undefined) {
    const grants = sanitizeStageGrants(input.stageGrants);
    data.stageGrants = {
      deleteMany: {},
      create: grants.map((g) => ({ organizationId: orgId, ...g })),
    };
  }
  if (input.pipelineGrants !== undefined) {
    const grants = sanitizePipelineGrants(input.pipelineGrants);
    data.pipelineGrants = {
      deleteMany: {},
      create: grants.map((g) => ({ organizationId: orgId, ...g })),
    };
  }
  if (input.fieldGrants !== undefined) {
    const grants = sanitizeFieldGrants(input.fieldGrants);
    data.fieldGrants = {
      deleteMany: {},
      create: grants.map((g) => ({ organizationId: orgId, ...g })),
    };
  }

  const role = await prisma.role.update({
    where: { id },
    data,
    select: roleDetailSelect,
  });

  await invalidateAuthzForOrg(orgId);
  return mapRoleDetail(role);
}

export async function deleteRole(id: string) {
  const orgId = getOrgIdOrThrow();
  const existing = await prisma.role.findFirst({
    where: { id, organizationId: orgId },
    select: { id: true, isSystem: true, _count: { select: { assignments: true } } },
  });
  if (!existing) return null;
  if (existing.isSystem) {
    throw new Error("Roles de sistema não podem ser excluídos.");
  }
  if (existing._count.assignments > 0) {
    const n = existing._count.assignments;
    throw new Error(
      `Este grupo tem ${n} ${n === 1 ? "membro" : "membros"}. ` +
        "Mova-os para outro grupo antes de excluir.",
    );
  }

  await prisma.role.delete({ where: { id } });
  await invalidateAuthzForOrg(orgId);
  return { ok: true as const };
}

export async function addRoleAssignment(roleId: string, userId: string) {
  const orgId = getOrgIdOrThrow();
  const role = await prisma.role.findFirst({
    where: { id: roleId, organizationId: orgId },
    select: { id: true },
  });
  if (!role) return null;

  const user = await prisma.user.findFirst({
    where: { id: userId, organizationId: orgId, type: "HUMAN", isErased: false },
    select: { id: true },
  });
  if (!user) throw new Error("Usuário não encontrado nesta organização.");

  await prisma.userRoleAssignment.upsert({
    where: { userId_roleId: { userId, roleId } },
    create: { userId, roleId, organizationId: orgId },
    update: {},
  });

  await invalidateAuthzForOrg(orgId);
  return getRoleById(roleId);
}

export async function removeRoleAssignment(roleId: string, userId: string) {
  const orgId = getOrgIdOrThrow();
  const deleted = await prisma.userRoleAssignment.deleteMany({
    where: { roleId, userId, organizationId: orgId },
  });
  if (deleted.count === 0) return null;
  await invalidateAuthzForOrg(orgId);
  return { ok: true as const };
}
