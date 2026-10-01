/**
 * Leitores "uma vez por requisição" dos insumos de autorização (P-10).
 *
 * Cada função é o leitor de sempre (`loadAuthzContext`, `isFeatureEnabled`,
 * `getScopeGrants`, `getOrgSettingsByPrefix`) atrás do memo da requisição
 * (`@/lib/request-memo`). Não há regra nova aqui: sem memo, cada chamada
 * cai direto no leitor original.
 */
import { loadAuthzContext, type AuthzContext } from "@/lib/authz";
import { getScopeGrants, type ScopeGrants } from "@/lib/authz/scope-grants";
import { isFeatureEnabled, type FlagKey } from "@/lib/feature-flags";
import { getOrgSettingsByPrefix } from "@/lib/org-settings";
import { getOrgIdOrNull } from "@/lib/request-context";
import { memoized, type RequestMemo } from "@/lib/request-memo";

export function authzContextOnce(
  memo: RequestMemo | undefined,
  input: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
): Promise<AuthzContext> {
  // `isSuperAdmin` entra na chave: o mesmo usuário carregado com e sem o
  // atalho de super-admin dá contextos diferentes.
  const key = `authz:${input.organizationId ?? "-"}:${input.userId}:${input.isSuperAdmin ? 1 : 0}`;
  return memoized(memo, key, () => loadAuthzContext(input));
}

export function featureEnabledOnce(
  memo: RequestMemo | undefined,
  key: FlagKey,
  organizationId: string,
): Promise<boolean> {
  return memoized(memo, `flag:${organizationId}:${key}`, () =>
    isFeatureEnabled(key, organizationId),
  );
}

/** `organizationId` ausente = org do RequestContext, como em `getScopeGrants()`. */
export function scopeGrantsOnce(
  memo: RequestMemo | undefined,
  organizationId?: string | null,
): Promise<ScopeGrants> {
  if (!memo) return getScopeGrants(organizationId);
  const org = organizationId ?? getOrgIdOrNull();
  return memoized(memo, `scope-grants:${org ?? "-"}`, () => getScopeGrants(organizationId));
}

/** Settings da org do RequestContext (mesma regra de `getOrgSettingsByPrefix`). */
export function orgSettingsByPrefixOnce(
  memo: RequestMemo | undefined,
  prefix: string,
): Promise<Map<string, string>> {
  if (!memo) return getOrgSettingsByPrefix(prefix);
  return memoized(memo, `org-settings:${getOrgIdOrNull() ?? "-"}:${prefix}`, () =>
    getOrgSettingsByPrefix(prefix),
  );
}
