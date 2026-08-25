/**
 * Authz core — `can`, `permissionsOf`, `requirePermission`.
 *
 * Modelo (Fase 1 Foundation):
 *   - User pode ter N Roles (M:N via `UserRoleAssignment`).
 *   - Cada Role tem `permissions: string[]` (chaves do catalogo).
 *   - Permissions efetivas do user = uniao das permissions de todos os
 *     roles atribuidos a ele NA ORGANIZACAO ATUAL.
 *   - Wildcards: "*" = todas; "<resource>:*" = todas as actions do recurso.
 *
 * Performance:
 *   - Hot path `can(ctx, key)` e O(1) via `Set.has`. A construcao do
 *     Set vem do banco mas e cacheada via `cache.wrap` (TTL 60s + lock
 *     anti-stampede). Mutations chamam `invalidateAuthzForUser(orgId, userId)`
 *     pra zerar a cache imediatamente.
 *
 * Super-admin EduIT:
 *   - `isSuperAdmin=true` bypassa qualquer checagem (retorna true sempre).
 *   - Mesmo padrao do RLS Postgres (BYPASSRLS no role).
 *
 * Tenant isolation:
 *   - permissions vem so de roles da organizationId do user. Nunca
 *     cruzamos org. Defesa em profundidade: RLS ja impede leak
 *     (`roles.organizationId = current_setting(...)`).
 *
 * Lockout impossivel:
 *   - Se um admin acidentalmente esvaziar `permissions` do preset ADMIN,
 *     `can(adminCtx, anything)` retornaria false. Pra prevenir, `can`
 *     SEMPRE retorna true se o user tem algum role com `systemPreset
 *     === "ADMIN"` — esse e o "kill switch" de seguranca. Detalhes em
 *     `loadAuthzContext`. Validacao adicional na UI (nao deixa salvar
 *     ADMIN com permissions vazias) e no service de update de Role.
 */

import { NextResponse } from "next/server";
import { UserRole, type UserRole as UserRoleEnum } from "@prisma/client";

import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";

import { isValidPermissionKey, type PermissionKey } from "./permissions";
import { PRESET_PERMISSIONS } from "./presets";

const log = getLogger("authz");

// Chave namespaced por org (`authz:<orgId>:user:<userId>`) para que
// `invalidateAuthzForOrg` apague APENAS os users daquela org via
// delPattern — antes era `authz:user:*` global, que derrubava o cache
// de TODOS os tenants no mesmo Redis a cada edição de Role.
const CACHE_TTL_SEC = 60;

// ──────────────────────────────────────────────
// Tipos publicos
// ──────────────────────────────────────────────

/**
 * Contexto leve de authz, derivado de uma sessao. Usado pra checagens
 * em hot paths (rotas, server components, sidebar). Conter `Set` direto
 * em vez de array torna `can()` O(1).
 *
 * `isAdmin` aqui e o kill switch — true sempre que o user tem algum
 * role `systemPreset="ADMIN"` (independente das permissions do preset).
 */
export type ScopeLevel = "NONE" | "SELF" | "TEAM" | "ALL";

/**
 * Grants de etapa/campo/extras resolvidos a partir dos PAPEIS do usuario
 * (uniao entre papeis). Substituem o antigo modelo por Grupo. Aplicados no
 * enforcement (resource-policy / visibility) atras da flag
 * `rbac_granular_scope_v1`.
 *
 * Semantica:
 *   - stageView/stageEdit: `null` = sem restricao (ve/edita todas as etapas).
 *     Conjunto = allow-list (uniao entre papeis; mais permissivo vence).
 *   - fieldDenyView/fieldDenyEdit: mascaramento por "entity.fieldKey".
 *     Deny vence: campo negado por QUALQUER papel fica oculto/somente-leitura.
 *   - sharedInbox/mediaAccess: OR entre papeis (default permissivo).
 */
export interface RoleGrantContext {
  stageView: ReadonlySet<string> | null;
  stageEdit: ReadonlySet<string> | null;
  fieldDenyView: ReadonlySet<string>;
  fieldDenyEdit: ReadonlySet<string>;
  sharedInbox: boolean;
  mediaAccess: boolean;
}

export interface AuthzContext extends RoleGrantContext {
  userId: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  permissions: ReadonlySet<string>;
}

/**
 * Versao serializavel do contexto pra cache (Set -> Array).
 */
interface CachedAuthzPayload {
  organizationId: string | null;
  isAdmin: boolean;
  permissions: string[];
  stageView: string[] | null;
  stageEdit: string[] | null;
  fieldDenyView: string[];
  fieldDenyEdit: string[];
  sharedInbox: boolean;
  mediaAccess: boolean;
}

/** Contexto de grants vazio/permissivo (super-admin, sem org, etc.). */
const PERMISSIVE_GRANTS: RoleGrantContext = {
  stageView: null,
  stageEdit: null,
  fieldDenyView: new Set(),
  fieldDenyEdit: new Set(),
  sharedInbox: true,
  mediaAccess: true,
};

// ──────────────────────────────────────────────
// Carregamento + cache
// ──────────────────────────────────────────────

function cacheKey(organizationId: string, userId: string): string {
  return `authz:${organizationId}:user:${userId}`;
}

/**
 * Le os roles + permissions do user direto do banco. Usa prismaBase
 * (sem RLS) porque pode rodar fora de RequestContext (ex.: middleware
 * ou hot-path antes do scope estar configurado). A query restringe
 * por organizationId pra defesa em profundidade.
 */
const LEGACY_ROLES = new Set<UserRoleEnum>([
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.MEMBER,
]);

/**
 * Fallback quando `user_role_assignments` está vazio (org criada após
 * signup sem seed, migration não rodada, ou bug antigo no POST /users).
 * Usa `User.role` legado + preset da org (ou constante TS) pra não
 * barrar operação em produção — DNA e demais orgs continuam funcionando.
 */
async function applyLegacyRoleFallback(
  userId: string,
  organizationId: string,
  merged: Set<string>,
  isAdmin: boolean,
): Promise<{ permissions: Set<string>; isAdmin: boolean }> {
  if (merged.size > 0 || isAdmin) {
    return { permissions: merged, isAdmin };
  }

  const user = await prismaBase.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const legacy = user?.role;
  if (!legacy || !LEGACY_ROLES.has(legacy)) {
    return { permissions: merged, isAdmin };
  }

  if (legacy === UserRole.ADMIN) {
    return { permissions: merged, isAdmin: true };
  }

  const presetRow = await prismaBase.role.findFirst({
    where: { organizationId, systemPreset: legacy },
    select: { permissions: true },
  });
  const source = presetRow?.permissions?.length
    ? presetRow.permissions
    : [...PRESET_PERMISSIONS[legacy]];

  for (const p of source) {
    if (isValidPermissionKey(p)) merged.add(p);
  }
  return { permissions: merged, isAdmin };
}

async function loadFromDb(
  userId: string,
  organizationId: string,
): Promise<CachedAuthzPayload> {
  const assignments = await prismaBase.userRoleAssignment.findMany({
    where: { userId, organizationId },
    select: {
      role: {
        select: {
          systemPreset: true,
          permissions: true,
          sharedInbox: true,
          mediaAccess: true,
          stageGrants: { select: { stageId: true, canView: true, canEdit: true } },
          fieldGrants: {
            select: { entity: true, fieldKey: true, canView: true, canEdit: true },
          },
        },
      },
    },
  });

  const merged = new Set<string>();
  let isAdmin = false;

  // Grants por papel (uniao). Ver `RoleGrantContext` para a semantica.
  let sawAnyRole = false;
  let anyRoleUnrestrictedStage = false;
  const stageViewSet = new Set<string>();
  const stageEditSet = new Set<string>();
  const fieldDenyView = new Set<string>();
  const fieldDenyEdit = new Set<string>();
  let sharedInbox = false;
  let mediaAccess = false;

  for (const a of assignments) {
    sawAnyRole = true;
    if (a.role.systemPreset === "ADMIN") isAdmin = true;
    for (const p of a.role.permissions) {
      if (isValidPermissionKey(p)) merged.add(p);
    }

    // Extras (OR — mais permissivo vence).
    if (a.role.sharedInbox) sharedInbox = true;
    if (a.role.mediaAccess) mediaAccess = true;

    // Etapas: papel sem NENHUM grant = irrestrito (ve todas). Editar implica ver.
    if (!a.role.stageGrants || a.role.stageGrants.length === 0) {
      anyRoleUnrestrictedStage = true;
    } else {
      for (const g of a.role.stageGrants) {
        if (g.canView || g.canEdit) stageViewSet.add(g.stageId);
        if (g.canEdit) stageEditSet.add(g.stageId);
      }
    }

    // Campos: deny vence. canView=false oculta (e portanto tambem impede editar).
    for (const g of a.role.fieldGrants ?? []) {
      const key = `${g.entity}.${g.fieldKey}`;
      if (!g.canView) {
        fieldDenyView.add(key);
        fieldDenyEdit.add(key);
      }
      if (!g.canEdit) fieldDenyEdit.add(key);
    }
  }

  const fallback = await applyLegacyRoleFallback(
    userId,
    organizationId,
    merged,
    isAdmin,
  );

  return {
    organizationId,
    isAdmin: fallback.isAdmin,
    permissions: Array.from(fallback.permissions),
    stageView: anyRoleUnrestrictedStage ? null : Array.from(stageViewSet),
    stageEdit: anyRoleUnrestrictedStage ? null : Array.from(stageEditSet),
    fieldDenyView: Array.from(fieldDenyView),
    fieldDenyEdit: Array.from(fieldDenyEdit),
    // Sem papeis atribuidos → permissivo (fallback legado cuida das permissions).
    sharedInbox: sawAnyRole ? sharedInbox : true,
    mediaAccess: sawAnyRole ? mediaAccess : true,
  };
}

/**
 * Constroi o AuthzContext a partir de uma sessao minima. E o ponto de
 * entrada pra todo callsite que precisa consultar permissions.
 *
 * Performance: cache.wrap com stampede protection. Se o user tem 5
 * roles, ainda e UMA query por TTL.
 *
 * Super-admin EduIT: retorna shortcut sem tocar no banco — eles
 * bypassam authz inteiramente (`isSuperAdmin=true`, `isAdmin=true`,
 * permissions vazia mas `can` ja retorna true antes de checar).
 */
export async function loadAuthzContext(input: {
  userId: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
}): Promise<AuthzContext> {
  if (input.isSuperAdmin) {
    return {
      userId: input.userId,
      organizationId: input.organizationId,
      isSuperAdmin: true,
      isAdmin: true,
      permissions: new Set(),
      ...PERMISSIVE_GRANTS,
    };
  }

  if (!input.organizationId) {
    // User sem org e sem super-admin = estado invalido. Retorna
    // contexto vazio pra que toda checagem falhe (fail-closed).
    log.warn({ userId: input.userId }, "[authz] user sem organizationId — contexto vazio");
    return {
      userId: input.userId,
      organizationId: null,
      isSuperAdmin: false,
      isAdmin: false,
      permissions: new Set(),
      ...PERMISSIVE_GRANTS,
    };
  }

  const orgId = input.organizationId;
  const payload = await cache.wrap<CachedAuthzPayload>(
    cacheKey(orgId, input.userId),
    CACHE_TTL_SEC,
    () => loadFromDb(input.userId, orgId),
  );

  return {
    userId: input.userId,
    organizationId: payload.organizationId,
    isSuperAdmin: false,
    isAdmin: payload.isAdmin,
    permissions: new Set(payload.permissions),
    stageView: payload.stageView ? new Set(payload.stageView) : null,
    stageEdit: payload.stageEdit ? new Set(payload.stageEdit) : null,
    fieldDenyView: new Set(payload.fieldDenyView ?? []),
    fieldDenyEdit: new Set(payload.fieldDenyEdit ?? []),
    sharedInbox: payload.sharedInbox ?? true,
    mediaAccess: payload.mediaAccess ?? true,
  };
}

// ──────────────────────────────────────────────
// Grants por papel (etapa/campo/extras) — enforcement de visibilidade
// ──────────────────────────────────────────────

/** Pode VER a etapa? `null` no contexto = sem restrição. ADMIN bypassa. */
export function canViewStage(ctx: AuthzContext, stageId: string): boolean {
  if (ctx.isSuperAdmin || ctx.isAdmin) return true;
  if (ctx.stageView === null) return true;
  return ctx.stageView.has(stageId);
}

/** Pode EDITAR/MOVER a etapa? `null` = sem restrição. ADMIN bypassa. */
export function canEditStage(ctx: AuthzContext, stageId: string): boolean {
  if (ctx.isSuperAdmin || ctx.isAdmin) return true;
  if (ctx.stageEdit === null) return true;
  return ctx.stageEdit.has(stageId);
}

/** IDs de etapas visíveis (para filtrar queries) ou `null` se irrestrito. */
export function allowedStageViewIds(ctx: AuthzContext): string[] | null {
  if (ctx.isSuperAdmin || ctx.isAdmin) return null;
  return ctx.stageView === null ? null : Array.from(ctx.stageView);
}

/** Pode VER o campo? Deny vence. ADMIN bypassa. */
export function canViewRoleField(
  ctx: AuthzContext,
  entity: string,
  fieldKey: string,
): boolean {
  if (ctx.isSuperAdmin || ctx.isAdmin) return true;
  return !ctx.fieldDenyView.has(`${entity}.${fieldKey}`);
}

/** Pode EDITAR o campo? Deny vence. ADMIN bypassa. */
export function canEditRoleField(
  ctx: AuthzContext,
  entity: string,
  fieldKey: string,
): boolean {
  if (ctx.isSuperAdmin || ctx.isAdmin) return true;
  return !ctx.fieldDenyEdit.has(`${entity}.${fieldKey}`);
}

// ──────────────────────────────────────────────
// Verificacao
// ──────────────────────────────────────────────

/**
 * Sync — checa uma permission contra um contexto ja carregado. Hot path.
 *
 * Ordem de checagem (curto-circuito):
 *   1. Super-admin EduIT → true (bypass total).
 *   2. Preset ADMIN → true (kill switch — preserva acesso mesmo se
 *      permissions do preset foram corrompidas).
 *   3. Permissao "*" presente → true.
 *   4. Permissao exata `<resource>:<action>` → true.
 *   5. Permissao wildcard `<resource>:*` → true.
 *   6. Caso contrario → false.
 */
export function can(ctx: AuthzContext, key: PermissionKey): boolean {
  if (ctx.isSuperAdmin) return true;
  if (ctx.isAdmin) return true;
  if (ctx.permissions.has("*")) return true;
  if (ctx.permissions.has(key)) return true;
  const colonIdx = key.indexOf(":");
  if (colonIdx > 0) {
    const resourceWildcard = `${key.slice(0, colonIdx)}:*`;
    if (ctx.permissions.has(resourceWildcard)) return true;
  }
  return false;
}

/**
 * Sync — checa se o user tem TODAS as permissions listadas. AND.
 */
export function canAll(ctx: AuthzContext, keys: PermissionKey[]): boolean {
  return keys.every((k) => can(ctx, k));
}

/**
 * Sync — checa se o user tem PELO MENOS UMA das permissions. OR.
 */
export function canAny(ctx: AuthzContext, keys: PermissionKey[]): boolean {
  return keys.some((k) => can(ctx, k));
}

/**
 * Async — atalho pra callsites que ainda nao carregaram contexto.
 * Cuidado: faz IO. Em hot paths, prefira passar o `AuthzContext`.
 */
export async function checkPermission(
  input: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
  key: PermissionKey,
): Promise<boolean> {
  const ctx = await loadAuthzContext(input);
  return can(ctx, key);
}

// ──────────────────────────────────────────────
// Helper de rota — composto com requireAuth
// ──────────────────────────────────────────────

/**
 * Devolve `null` se OK, ou `NextResponse` 401/403 caso contrario.
 *
 * Uso tipico:
 *   const r = await requireAuth();
 *   if (!r.ok) return r.response;
 *   const denied = await requirePermission(r.session.user, "pipeline:edit");
 *   if (denied) return denied;
 *
 * Vamos ter um wrapper de mais alto nivel em fase 2 que combina os dois,
 * mas por enquanto mantemos atomicos pra reaproveitar `requireAuth`.
 */
export async function requirePermission(
  user: { id: string; organizationId: string | null; isSuperAdmin: boolean },
  key: PermissionKey,
): Promise<NextResponse | null> {
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  });
  if (can(ctx, key)) return null;
  return NextResponse.json(
    { message: "Acesso negado.", required: key },
    { status: 403 },
  );
}

// ──────────────────────────────────────────────
// Invalidation (chamada em mutacoes de Role/UserRoleAssignment)
// ──────────────────────────────────────────────

/**
 * Invalida cache de authz de um user especifico. Chame em:
 *   - Apos atribuir/remover Role do user (UserRoleAssignment.create/delete).
 *   - Apos editar permissions de uma Role (em fase 2 vai invalidar TODOS
 *     os users com essa Role — usar `invalidateAuthzForOrg` ou
 *     `invalidateAuthzForRole`).
 */
export async function invalidateAuthzForUser(
  organizationId: string,
  userId: string,
): Promise<void> {
  await cache.del(cacheKey(organizationId, userId));
}

/**
 * Invalida cache de TODOS os users de uma org. Chame quando alterar
 * permissions de uma Role (afeta todos os assignments). Mais barato que
 * iterar por user ID porque usa `delPattern` em SCAN batch.
 *
 * O pattern e namespaced por org (`authz:<orgId>:user:*`) — em deploys
 * multi-org no mesmo Redis, users de OUTRAS orgs nao sao afetados.
 */
export async function invalidateAuthzForOrg(organizationId: string): Promise<void> {
  await cache.delPattern(`authz:${organizationId}:user:*`);
}

/**
 * Re-export tipos pra ergonomia do callsite.
 */
export type { PermissionKey } from "./permissions";

/**
 * Compat helper: traduz UserRole enum -> systemPreset string.
 * Mantido aqui pra centralizar a conversao usada em todos os callsites
 * legados que ainda comparam `user.role === "ADMIN"`.
 */
export function isPresetAdmin(role: UserRole | null | undefined): boolean {
  return role === "ADMIN";
}
