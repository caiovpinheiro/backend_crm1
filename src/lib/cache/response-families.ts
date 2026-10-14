/**
 * Famílias de versão das respostas de inicialização em cache e o bump
 * (invalidação). Separado de `response-cache.ts` para os workers (Baileys)
 * invalidarem sem importar `next/server`.
 */
import { getLogger } from "@/lib/logger";

import { bumpCacheVersion, cacheVersionName } from "./versions";

const log = getLogger("cache/response");

/**
 * Famílias de versão das respostas de inicialização. Cada uma é
 * `cache:v:<família>:<org>`. Escritores que precisam invalidar (bump):
 *
 * - `org_settings` (já existia): `setOrgSetting`/`deleteOrgSetting`.
 *   Cobre `/api/settings/org`, `/api/settings/visibility` e a lista de ids
 *   da extensão do card.
 * - `rc_channels`: create/update/delete/status de canal (`services/channels.ts`,
 *   workers Baileys).
 * - `rc_quick_replies`: respostas rápidas e grupos (rotas de settings,
 *   `services/quick-replies.ts`, onboarding, reparo de mídia).
 * - `rc_pipelines`: funis e etapas (`services/pipelines.ts`, auto-deals,
 *   onboarding, motivos de perda que mexem no funil).
 * - `rc_custom_fields`: definições de campo personalizado.
 * - `rc_departments`: departamentos e membros.
 * - `rc_users`: usuários (criar/editar/apagar/papel/status de agente).
 * - `rc_field_layout`: layout de campos (admin e por usuário).
 * - `rc_loss_reasons`: motivos de perda.
 */
export const RESPONSE_FAMILIES = {
  orgSettings: "org_settings",
  channels: "rc_channels",
  quickReplies: "rc_quick_replies",
  pipelines: "rc_pipelines",
  customFields: "rc_custom_fields",
  departments: "rc_departments",
  users: "rc_users",
  fieldLayout: "rc_field_layout",
  lossReasons: "rc_loss_reasons",
  /** Já existia: muda quando um ticket troca de aba (status/departamento). */
  inboxTabCounts: "inbox_tab_counts",
  /** Já existia: papéis/permissões da org (`invalidateAuthzForOrg`). */
  authz: "authz",
} as const;

export type ResponseFamily = (typeof RESPONSE_FAMILIES)[keyof typeof RESPONSE_FAMILIES];

/**
 * Família POR USUÁRIO do bootstrap estável (`GET /api/me/bootstrap` com
 * `x-bootstrap-version: 2`, ver `services/me-bootstrap-cache.ts`):
 * `cache:v:rc_me:<org>:<usuário>`. Prefixo `rc_` = sem memória local da
 * versão (`versions.ts`): a outra réplica enxerga o bump na próxima leitura.
 *
 * Escritores (o dado do PRÓPRIO usuário que entra no bootstrap): perfil
 * (`PUT /api/profile`), preferências (sidebar/dashboard/aparência), edição e
 * exclusão do usuário pela Equipe (`/api/users/:id`), papel/atribuição
 * (`invalidateAuthzForUser`), `AgentPermission` do usuário e anonimização
 * (LGPD). O que é da org inteira (papéis, departamentos, settings, marca,
 * widgets, canais) entra pelas famílias da org.
 */
export const ME_BOOTSTRAP_FAMILY = "rc_me";

export function meBootstrapVersionName(orgId: string, userId: string): string {
  return cacheVersionName(ME_BOOTSTRAP_FAMILY, orgId, userId);
}

/** Invalida o bootstrap estável dos usuários (um INCR cada). Nunca lança. */
export async function bumpMeBootstrap(
  orgId: string | null | undefined,
  ...userIds: (string | null | undefined)[]
): Promise<void> {
  const ids = userIds.filter((id): id is string => Boolean(id));
  if (!orgId || ids.length === 0) return;
  try {
    await bumpCacheVersion(...ids.map((id) => meBootstrapVersionName(orgId, id)));
  } catch (err) {
    log.warn({ err, orgId, userIds: ids }, "[response-cache] bump do bootstrap falhou");
  }
}

/**
 * Invalida as famílias da org (um INCR por família). Nunca lança: o cache
 * é best-effort e o TTL cobre a falha.
 */
export async function bumpResponseFamilies(
  orgId: string | null | undefined,
  ...families: ResponseFamily[]
): Promise<void> {
  if (!orgId || families.length === 0) return;
  try {
    await bumpCacheVersion(...families.map((f) => cacheVersionName(f, orgId)));
  } catch (err) {
    log.warn({ err, orgId, families }, "[response-cache] bump falhou");
  }
}
