import { cache } from "@/lib/cache";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { parseScopeGrants, type ScopeGrants } from "@/lib/authz/scope-grants-shared";

export type {
  ScopeGrants,
  CrmActionKey,
  CrmActionGrants,
  UserScopeGrants,
} from "@/lib/authz/scope-grants-shared";
export {
  canAccessField,
  canAccessScopedResource,
  canAccessPipelineForUser,
  canAccessChannelForUser,
  listAllowedPipelineIdsForUser,
  listAllowedChannelIdsForUser,
  canSeeInboxTab,
  canSeeSettingsItem,
  canSeeSidebarRoute,
  listAllowedInboxTabsForUser,
  INBOX_TAB_BAR_ORDER,
  parseScopeGrants,
  readCrmActionGrant,
  mergeCrmActionGrantsForUser,
  CRM_ACTION_KEYS,
} from "@/lib/authz/scope-grants-shared";

const SETTINGS_KEY = "permissions.scope.grants.v1";

/**
 * Grants mudam raramente e são lidos em todo request quente (inbox,
 * mensagens, políticas de canal — 2× por `GET /api/conversations`). TTL
 * curto como rede de segurança; a escrita invalida explicitamente.
 */
const SCOPE_GRANTS_TTL_SEC = 60;

export function scopeGrantsCacheKey(organizationId: string): string {
  return `scope_grants:v1:${organizationId}`;
}

async function loadScopeGrantsFromDb(organizationId: string): Promise<ScopeGrants> {
  const row = await prismaBase.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId, key: SETTINGS_KEY } },
    select: { value: true },
  });
  if (!row?.value) return {};
  try {
    return parseScopeGrants(JSON.parse(row.value));
  } catch {
    return {};
  }
}

export async function getScopeGrants(organizationIdArg?: string | null): Promise<ScopeGrants> {
  const organizationId = organizationIdArg ?? getOrgIdOrThrow();
  if (!organizationId) return {};
  return cache.wrap(scopeGrantsCacheKey(organizationId), SCOPE_GRANTS_TTL_SEC, () =>
    loadScopeGrantsFromDb(organizationId),
  );
}

export async function setScopeGrants(grants: ScopeGrants): Promise<void> {
  const organizationId = getOrgIdOrThrow();
  await setScopeGrantsForOrg(organizationId, grants);
}

/** Persistência sem RequestContext (aceite de convite público). */
export async function setScopeGrantsForOrg(
  organizationId: string,
  grants: ScopeGrants,
): Promise<void> {
  const value = JSON.stringify(parseScopeGrants(grants));
  await prismaBase.organizationSetting.upsert({
    where: { organizationId_key: { organizationId, key: SETTINGS_KEY } },
    create: { organizationId, key: SETTINGS_KEY, value },
    update: { value },
  });
  // Invalida depois de gravar: quem lê em seguida (PUT → GET de
  // confirmação) já vê o valor novo, nesta e nas outras réplicas.
  await cache.del(scopeGrantsCacheKey(organizationId));
}
