import type { Prisma } from "@prisma/client";

import { invalidateAuthzForUser } from "@/lib/authz";
import {
  PRESET_DESCRIPTION,
  PRESET_LABEL,
  PRESET_PERMISSIONS,
} from "@/lib/authz/presets";

const SYSTEM_PRESETS = ["ADMIN", "MANAGER", "MEMBER"] as const;

/**
 * Garante que os 3 presets de sistema (ADMIN/MANAGER/MEMBER) existam na
 * organizacao. Idempotente e NAO-destrutivo: cria apenas os que faltam,
 * preservando permissions customizadas de presets ja existentes.
 *
 * Motivacao (bug 2026-06): orgs criadas via `registerOrganization`
 * (onboarding/signup) nasciam SEM nenhuma Role de preset — apenas a
 * migration de RBAC semeava os presets. Resultado: criar um usuario
 * MANAGER/MEMBER via UI nao encontrava a Role preset e o usuario ficava
 * com `permissions = []` (barrado em toda rota com `can()`). Chamar isto
 * antes de atribuir torna o fluxo auto-curavel pra qualquer org.
 *
 * Race-safe via `createMany({ skipDuplicates })` apoiado no unique index
 * `roles_organizationId_systemPreset_key`.
 */
export async function ensureSystemPresetRoles(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  const existing = await tx.role.findMany({
    where: {
      organizationId,
      systemPreset: { in: ["ADMIN", "MANAGER", "MEMBER"] },
    },
    select: { systemPreset: true },
  });
  const have = new Set(existing.map((r) => r.systemPreset));
  const missing = SYSTEM_PRESETS.filter((p) => !have.has(p));
  if (missing.length === 0) return;

  await tx.role.createMany({
    data: missing.map((preset) => ({
      organizationId,
      name: PRESET_LABEL[preset],
      description: PRESET_DESCRIPTION[preset],
      systemPreset: preset,
      isSystem: true,
      permissions: [...PRESET_PERMISSIONS[preset]],
    })),
    skipDuplicates: true,
  });
}

/**
 * Sincroniza UserRoleAssignment do usuario com o preset legado
 * (`User.role` = ADMIN/MANAGER/MEMBER).
 *
 * Bug de origem (2026-05-20): rotas `POST /api/users` e `PUT /api/users/[id]`
 * criavam/atualizavam o campo `User.role` mas nao tocavam em
 * `UserRoleAssignment`. Como `loadAuthzContext` busca permissions
 * apenas em `user_role_assignments`, qualquer user criado via UI ficava
 * com `permissions = []` e era barrado por toda rota que usa `can()`.
 *
 * Estrategia:
 *   1. Encontra a Role da org com `systemPreset = <role>` (preset
 *      criado no seed/Phase1 — sempre existe).
 *   2. Remove outras assignments de preset desta org (mantem custom
 *      roles intactas — so derruba os 3 presets antigos).
 *   3. Upsert assignment do preset alvo.
 *   4. Invalida cache de authz do user.
 *
 * Operacao idempotente: rodar 2x da o mesmo resultado.
 *
 * Caso a Role preset nao exista (org legada antes da Fase 1), retornamos
 * `false` e o caller pode logar/decidir. Isso NAO deve acontecer em orgs
 * novas porque a Phase1 migration cria as 3 presets pra cada org.
 */
export async function syncUserRoleAssignment(
  tx: Prisma.TransactionClient,
  args: {
    userId: string;
    organizationId: string;
    role: "ADMIN" | "MANAGER" | "MEMBER";
    assignedById?: string | null;
  },
): Promise<boolean> {
  // Auto-cura: garante os presets da org antes de procurar o alvo. Cobre
  // orgs criadas sem seed de RBAC (onboarding/signup) — ver doc da funcao.
  await ensureSystemPresetRoles(tx, args.organizationId);

  const presetRole = await tx.role.findFirst({
    where: {
      organizationId: args.organizationId,
      systemPreset: args.role,
    },
    select: { id: true },
  });

  if (!presetRole) {
    return false;
  }

  const otherPresetRoleIds = (
    await tx.role.findMany({
      where: {
        organizationId: args.organizationId,
        systemPreset: { in: ["ADMIN", "MANAGER", "MEMBER"], not: args.role },
      },
      select: { id: true },
    })
  ).map((r) => r.id);

  if (otherPresetRoleIds.length > 0) {
    await tx.userRoleAssignment.deleteMany({
      where: {
        userId: args.userId,
        organizationId: args.organizationId,
        roleId: { in: otherPresetRoleIds },
      },
    });
  }

  await tx.userRoleAssignment.upsert({
    where: {
      userId_roleId: {
        userId: args.userId,
        roleId: presetRole.id,
      },
    },
    create: {
      userId: args.userId,
      roleId: presetRole.id,
      organizationId: args.organizationId,
      assignedById: args.assignedById ?? null,
    },
    update: {},
  });

  await invalidateAuthzForUser(args.organizationId, args.userId);
  return true;
}

const VALID_LEGACY_ROLES = ["ADMIN", "MANAGER", "MEMBER"] as const;

/**
 * Auto-cura: usuários HUMAN da org sem nenhum assignment recebem o preset
 * compatível com `User.role`. Idempotente — só cria o que falta. Chamado
 * ao listar roles (admin abre /settings/permissions) pra DNA/prod não
 * ficarem com operadores barrados após deploy.
 */
export async function syncMissingUserRoleAssignments(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<number> {
  await ensureSystemPresetRoles(tx, organizationId);

  const users = await tx.user.findMany({
    where: { organizationId, type: "HUMAN", isErased: false },
    select: { id: true, role: true },
  });

  let healed = 0;
  for (const u of users) {
    if (!VALID_LEGACY_ROLES.includes(u.role as (typeof VALID_LEGACY_ROLES)[number])) {
      continue;
    }
    const hasAny = await tx.userRoleAssignment.findFirst({
      where: { userId: u.id, organizationId },
      select: { id: true },
    });
    if (hasAny) continue;

    const ok = await syncUserRoleAssignment(tx, {
      userId: u.id,
      organizationId,
      role: u.role as "ADMIN" | "MANAGER" | "MEMBER",
    });
    if (ok) healed++;
  }
  return healed;
}
