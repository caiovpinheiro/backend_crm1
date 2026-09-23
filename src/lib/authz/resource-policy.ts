import { NextResponse } from "next/server";

import {
  loadAuthzContext,
  can,
  canViewPipeline,
  canViewStage,
  canEditStage,
  canViewRoleField,
  canEditRoleField,
  type PermissionKey,
} from "@/lib/authz";
import {
  canAccessScopedResource,
  canAccessPipelineForUser,
  canAccessChannelForUser,
  listAllowedPipelineIdsForUser,
  listAllowedChannelIdsForUser,
  getScopeGrants,
  readCrmActionGrant,
  type CrmActionKey,
  type ScopeGrants,
} from "@/lib/authz/scope-grants";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { prismaBase } from "@/lib/prisma-base";

/**
 * IDs das roles (RBAC) atribuídas ao usuário. Usado para resolver grants de
 * canal por papel (eixo aditivo de `channel.*.roles`). Só é chamado quando a
 * flag de escopo granular está ligada.
 */
async function getUserAssignedRoleIds(userId: string): Promise<string[]> {
  const rows = await prismaBase.userRoleAssignment.findMany({
    where: { userId },
    select: { roleId: true },
  });
  return rows.map((r) => r.roleId);
}

type UserLike = {
  id: string;
  role?: string | null;
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

/**
 * Mapeamento PermissionKey (RBAC tradicional) → CrmActionKey (toggles
 * por usuário em /settings/permissions).
 *
 * Quando o RBAC nega uma dessas keys, o handler ainda consulta o
 * `scopeGrants.crm.<crmAction>.users[userId]` da org. Se houver override
 * `true`, libera; se houver `false`, mantém o 403; se ausente, mantém o
 * 403 (default deny no backend — mais seguro que o `default true` da lib
 * do frontend, que é só client-side gate).
 *
 * Mantido conservador (29/mai/26): cobre só o que efetivamente quebrava
 * o fluxo do operador. Pra adicionar mais permissões à mesma ação,
 * estender este map — sem precisar tocar o handler.
 */
const RBAC_TO_CRM_ACTION: Partial<Record<PermissionKey, CrmActionKey>> = {
  "deal:change_stage": "editLeads",
  "deal:edit": "editLeads",
  "contact:edit": "editLeads",
  "deal:transfer_owner": "assignOwner",
};

async function userHasCrmActionGrant(
  user: UserLike,
  action: CrmActionKey,
): Promise<boolean> {
  if (!user.organizationId) return false;
  const grants = await getScopeGrants(user.organizationId);
  const value = readCrmActionGrant(grants, action, user.id);
  return value === true;
}

export async function requirePermissionForUser(
  user: UserLike,
  key: PermissionKey,
): Promise<NextResponse | null> {
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  });
  if (can(ctx, key)) return null;

  // Override por usuário via /settings/permissions (UI por toggle).
  // Doc: scope-grants-shared.ts → CrmActionKey. Mapa em RBAC_TO_CRM_ACTION
  // acima. ADMIN nunca cai aqui porque can() já libera tudo pra ele;
  // este path só importa pra MANAGER/MEMBER que ganhou grant explícito.
  const crmAction = RBAC_TO_CRM_ACTION[key];
  if (crmAction && (await userHasCrmActionGrant(user, crmAction))) {
    return null;
  }

  return NextResponse.json({ message: "Acesso negado.", required: key }, { status: 403 });
}

export async function loadScopedPolicy(user: UserLike): Promise<{
  enabled: boolean;
  grants: ScopeGrants;
}> {
  if (!user.organizationId) return { enabled: false, grants: {} };
  const enabled = await isFeatureEnabled("rbac_granular_scope_v1", user.organizationId);
  if (!enabled) return { enabled: false, grants: {} };
  return { enabled: true, grants: await getScopeGrants(user.organizationId) };
}

export async function requirePipelineScope(
  user: UserLike,
  action: "view" | "edit",
  pipelineId: string,
): Promise<NextResponse | null> {
  if (user.organizationId && pipelineId) {
    const ctx = await loadAuthzContext({
      userId: user.id,
      organizationId: user.organizationId,
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
    if (!canViewPipeline(ctx, pipelineId)) {
      return NextResponse.json({ message: "Acesso negado ao funil." }, { status: 403 });
    }
  }
  const policy = await loadScopedPolicy(user);
  if (!policy.enabled) return null;
  // "view" considera o override por usuário (lista de funis); "edit"
  // continua governado pela regra por papel.
  const allowed =
    action === "view"
      ? canAccessPipelineForUser({
          grants: policy.grants,
          role: user.role,
          userId: user.id,
          pipelineId,
        })
      : canAccessScopedResource({
          grants: policy.grants,
          role: user.role,
          resource: "pipeline",
          action,
          targetId: pipelineId,
        });
  if (allowed) return null;
  return NextResponse.json({ message: "Acesso negado ao funil." }, { status: 403 });
}

/**
 * IDs de funis que o usuário pode ver, para filtrar listagens/queries.
 * Retorna `null` quando não há restrição (flag off ou acesso a todos).
 */
export async function listAllowedPipelineIds(
  user: UserLike,
): Promise<string[] | null> {
  const policy = await loadScopedPolicy(user);
  if (!policy.enabled) return null;
  return listAllowedPipelineIdsForUser({
    grants: policy.grants,
    role: user.role,
    userId: user.id,
  });
}

/**
 * Versão boolean de `requireChannelScope` — pra payloads que precisam expor
 * "pode/não pode" sem instanciar uma 403 NextResponse. Mesma precedência:
 *   - flag off → permissivo (true)
 *   - sem channelId → permissivo (true)
 *   - delega pra canAccessChannelForUser (deny/manage/anti-lockout aplicados)
 */
export async function canDoChannelAction(
  user: UserLike,
  action: "view" | "send" | "initiate" | "manage",
  channelId: string | null | undefined,
): Promise<boolean> {
  if (!channelId) return true;
  const policy = await loadScopedPolicy(user);
  if (!policy.enabled) return true;
  const roleIds = await getUserAssignedRoleIds(user.id);
  return canAccessChannelForUser({
    grants: policy.grants,
    role: user.role,
    userId: user.id,
    action,
    channelId,
    roleIds,
  });
}

/**
 * Mensagem 403 por ação. Mantida fora da função pra facilitar i18n futura.
 */
const CHANNEL_SCOPE_DENIED_MESSAGE: Record<
  "view" | "send" | "initiate" | "manage",
  string
> = {
  view: "Sem acesso a este canal.",
  send: "Sem permissão para enviar neste canal.",
  initiate: "Sem permissão para iniciar conversa neste canal.",
  manage: "Sem permissão para administrar este canal.",
};

/**
 * Escopo de canal por usuário. Ações:
 *   - `view`     — ler conversas/mensagens do canal
 *   - `send`     — responder em conversa existente (exige view)
 *   - `initiate` — iniciar conversa nova (exige view)
 *   - `manage`   — administrar o canal (implica view+send+initiate)
 *
 * `channelId` ausente (conversa legada sem canal) → não escopa (mantém
 * compat com conversas pré-feature).
 */
export async function requireChannelScope(
  user: UserLike,
  action: "view" | "send" | "initiate" | "manage",
  channelId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!channelId) return null;
  const policy = await loadScopedPolicy(user);
  if (!policy.enabled) return null;
  const roleIds = await getUserAssignedRoleIds(user.id);
  const allowed = canAccessChannelForUser({
    grants: policy.grants,
    role: user.role,
    userId: user.id,
    action,
    channelId,
    roleIds,
  });
  if (allowed) return null;
  return NextResponse.json(
    { message: CHANNEL_SCOPE_DENIED_MESSAGE[action] },
    { status: 403 },
  );
}

/**
 * IDs de canais que o usuário pode ver, para filtrar conversas.
 * Retorna `null` quando não há restrição (flag off ou acesso a todos).
 */
export async function listAllowedChannelIds(
  user: UserLike,
): Promise<string[] | null> {
  const policy = await loadScopedPolicy(user);
  if (!policy.enabled) return null;
  const roleIds = await getUserAssignedRoleIds(user.id);
  return listAllowedChannelIdsForUser({
    grants: policy.grants,
    role: user.role,
    userId: user.id,
    roleIds,
  });
}

export async function requireStageScope(
  user: UserLike,
  action: "view" | "edit" | "move",
  stageId: string,
): Promise<NextResponse | null> {
  if (!user.organizationId) return null;
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  });
  if (ctx.isSuperAdmin || ctx.isAdmin) return null;
  const allowed =
    action === "view" ? canViewStage(ctx, stageId) : canEditStage(ctx, stageId);
  if (!allowed) {
    return NextResponse.json({ message: "Acesso negado à etapa." }, { status: 403 });
  }
  if (ctx.pipelineDeny && ctx.pipelineDeny.size > 0) {
    const stage = await prismaBase.stage.findFirst({
      where: { id: stageId, organizationId: user.organizationId },
      select: { pipelineId: true },
    });
    if (stage && !canViewPipeline(ctx, stage.pipelineId)) {
      return NextResponse.json({ message: "Acesso negado ao funil." }, { status: 403 });
    }
  }
  return null;
}

export async function canEditFieldForUser(
  user: UserLike,
  entity: "deal" | "contact" | "product",
  fieldKey: string,
): Promise<boolean> {
  if (!user.organizationId) return true;
  const enabled = await isFeatureEnabled("rbac_granular_scope_v1", user.organizationId);
  if (!enabled) return true;
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  });
  return canEditRoleField(ctx, entity, fieldKey);
}

export async function canViewFieldForUser(
  user: UserLike,
  entity: "deal" | "contact" | "product",
  fieldKey: string,
): Promise<boolean> {
  if (!user.organizationId) return true;
  const enabled = await isFeatureEnabled("rbac_granular_scope_v1", user.organizationId);
  if (!enabled) return true;
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  });
  return canViewRoleField(ctx, entity, fieldKey);
}

