/**
 * Permissões efetivas de um usuário no contexto da organização.
 *
 * Lógica extraída de `GET /api/users/[id]/effective-permissions` para ser
 * reaproveitada por `GET /api/me/bootstrap` sem duplicar o fallback legado
 * (`User.role`), os grants de canal e o bloco F (`AgentPermission`).
 *
 * A rota continua responsável por: checar quem pode consultar quem
 * (`settings:permissions`), aplicar `userOrgFilter` e devolver 404.
 * Esta função assume que `user` já foi validado/carregado pelo caller e
 * que o `RequestContext` está ativo (usa `prisma` scoped).
 */

import type { UserRole } from "@prisma/client";

import { agentPermissionWhere } from "@/lib/agent-permission-where";
import { loadAuthzContext } from "@/lib/authz";
import { getScopeGrants } from "@/lib/authz/scope-grants";
import { listAllowedChannelIdsForUser } from "@/lib/authz/scope-grants-shared";
import { prisma } from "@/lib/prisma";

export type EffectivePermissionsUser = {
  id: string;
  role: UserRole | string | null | undefined;
  organizationId: string | null;
  isSuperAdmin: boolean | null | undefined;
};

export type EffectivePermissionsPayload = {
  permissions: string[];
  channelGrants: { id: string; name: string }[];
  stageGrants: never[];
  roles: { id: string; name: string; systemPreset: string | null }[];
  groups: never[];
};

/** MANAGER preset — lista representativa das ações principais (fallback legado). */
const LEGACY_MANAGER_PERMISSIONS = [
  "pipeline:view", "pipeline:create", "pipeline:edit", "pipeline:delete", "pipeline:manage_stages",
  "contact:view", "contact:create", "contact:edit", "contact:delete", "contact:export", "contact:import",
  "deal:view", "deal:create", "deal:edit", "deal:delete", "deal:transfer_owner", "deal:change_stage",
  "conversation:view", "conversation:claim", "conversation:reassign_others", "conversation:resolve",
  "automation:view", "automation:create", "automation:edit", "automation:publish",
  "distribution:view", "distribution:manage", "distribution:execute",
  "report:view", "report:export",
  "settings:team", "settings:branding", "settings:channels", "settings:custom_fields",
  "tag:view", "tag:create", "tag:edit",
  "task:view", "task:create", "task:edit", "task:complete_others",
];

/** MEMBER preset (fallback legado). */
const LEGACY_MEMBER_PERMISSIONS = [
  "pipeline:view",
  "contact:view", "contact:create", "contact:edit",
  "deal:view", "deal:create", "deal:edit", "deal:change_stage",
  "conversation:view", "conversation:claim", "conversation:resolve",
  "tag:view",
  "task:view", "task:create", "task:edit",
  "report:view",
  "distribution:view",
];

export async function computeEffectivePermissions(
  user: EffectivePermissionsUser,
): Promise<EffectivePermissionsPayload> {
  const id = user.id;
  const authzCtx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin ?? false,
  });

  // Super-admin ou admin recebem "*" para que useCan() funcione no client.
  // Para outros usuários, retornamos as permissions efetivas do Set.
  let permissions: string[];
  if (authzCtx.isSuperAdmin || authzCtx.isAdmin) {
    permissions = ["*"];
  } else if (authzCtx.permissions.size > 0) {
    permissions = Array.from(authzCtx.permissions);
  } else {
    // Fallback: se não há assignments ainda (usuário criado antes do seed de RBAC),
    // deriva permissões do campo User.role legado.
    const legacyRole = user.role;
    if (legacyRole === "ADMIN") {
      permissions = ["*"];
    } else if (legacyRole === "MANAGER") {
      permissions = [...LEGACY_MANAGER_PERMISSIONS];
    } else {
      permissions = [...LEGACY_MEMBER_PERMISSIONS];
    }
  }

  // Roles atribuídas ao usuário na organização.
  const assignments = await prisma.userRoleAssignment.findMany({
    where: { userId: id },
    select: {
      role: { select: { id: true, name: true, systemPreset: true } },
    },
  });

  const roles = assignments.map((a) => ({
    id: a.role.id,
    name: a.role.name,
    systemPreset: a.role.systemPreset,
  }));

  // Canais efetivos: união dos grants (user + roles), com deny aplicado.
  // Lê grants da org do user-alvo. Super-admin sem org ativa pode auditar
  // user de outra org; com org na sessão, o alvo já passou por userOrgFilter.
  const grants = await getScopeGrants(user.organizationId ?? null);
  const allowedIds = listAllowedChannelIdsForUser({
    grants,
    role: user.role,
    userId: id,
    roleIds: roles.map((r) => r.id),
  });
  let channelGrants: { id: string; name: string }[] = [];
  if (allowedIds && allowedIds.length > 0) {
    const chs = await prisma.channel.findMany({
      where: { id: { in: allowedIds } },
      select: { id: true, name: true },
    });
    channelGrants = chs.map((c) => ({ id: c.id, name: c.name }));
  }

  // Bloco F: AgentPermission.canConfigureFieldVisibility → settings:custom_fields.
  // Sempre filtra pela org do usuário já validado (tabela NÃO é global).
  if (!permissions.includes("*") && !permissions.includes("settings:custom_fields")) {
    try {
      const agentPerm = await prisma.agentPermission.findFirst({
        where: agentPermissionWhere(id, user.organizationId),
        select: { canConfigureFieldVisibility: true },
      });
      if (agentPerm?.canConfigureFieldVisibility === true) {
        permissions = [...permissions, "settings:custom_fields"];
      }
    } catch {
      // Tabela/coluna pode não existir ainda — ignore.
    }
  }

  return {
    permissions,
    channelGrants,
    stageGrants: [],
    roles,
    groups: [],
  };
}
