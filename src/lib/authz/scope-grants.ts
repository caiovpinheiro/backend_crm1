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

export async function getScopeGrants(organizationIdArg?: string | null): Promise<ScopeGrants> {
  const organizationId = organizationIdArg ?? getOrgIdOrThrow();
  if (!organizationId) return {};
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
}
