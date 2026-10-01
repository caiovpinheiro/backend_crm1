/**
 * Settings org-scoped — substitui SystemSetting para chaves per-tenant.
 *
 * Multi-tenancy v0: a tabela `system_settings` (legada) NAO tem
 * `organizationId`, entao toda escrita em chave per-tenant via aquele
 * caminho vazava pra todas as orgs. Este modulo le/grava em
 * `OrganizationSetting` (org-scoped + RLS) e e a fonte de verdade para
 * qualquer config que varia por cliente.
 *
 * Convencao de chaves:
 *
 *   - `visibility.<ROLE>`        — `lib/visibility.ts`
 *   - `selfAssign.<ROLE>`        — `lib/self-assign.ts`
 *   - `deals.loss_reason_required` — pipeline de deals
 *   - `ai.openai.api_key`         — chave OpenAI por org (criptografada)
 *
 * Quando usar `services/settings.ts` (system-wide)?
 *
 *   - APENAS para chaves verdadeiramente globais da plataforma EduIT
 *     (license keys, super-admin flags, feature flags cross-tenant).
 *   - Se a chave faz sentido ser diferente por cliente, USE este modulo.
 */

import { prisma } from "@/lib/prisma";
import { cache } from "@/lib/cache";
import { getOrgIdOrThrow, getOrgIdOrNull } from "@/lib/request-context";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

const TTL_SEC = 60;

function cacheKey(orgId: string, key: string): string {
  return `org_setting:${orgId}:${key}`;
}

function cachePrefixKey(orgId: string, prefix: string): string {
  return `org_settings_prefix:${orgId}:${prefix}`;
}

/**
 * Lê o valor de uma chave per-tenant. Retorna `null` se ausente.
 * Stampede-protected via `cache.wrap`.
 *
 * Throws se chamado fora de RequestContext (sem orgId resolvido).
 */
export async function getOrgSetting(key: string): Promise<string | null> {
  const orgId = getOrgIdOrThrow();
  return cache.wrap(cacheKey(orgId, key), TTL_SEC, async () => {
    const row = await prisma.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId: orgId, key } },
      select: { value: true },
    });
    return row?.value ?? null;
  });
}

/**
 * Versão que aceita orgId explícito — útil em workers/webhooks que
 * resolvem org de outra fonte e não rodam dentro de
 * `getRequestContext()`.
 */
export async function getOrgSettingFor(
  orgId: string,
  key: string,
): Promise<string | null> {
  return cache.wrap(cacheKey(orgId, key), TTL_SEC, async () => {
    const row = await prisma.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId: orgId, key } },
      select: { value: true },
    });
    return row?.value ?? null;
  });
}

/**
 * Lê todas as chaves per-tenant que começam com `prefix`. Retorna `Map`
 * vazio se nenhuma. Cacheado pelo prefixo (invalidado em qualquer
 * `setOrgSetting`/`deleteOrgSetting` que toque chave matching).
 */
export async function getOrgSettingsByPrefix(
  prefix: string,
): Promise<Map<string, string>> {
  const orgId = getOrgIdOrThrow();
  const raw = await cache.wrap(
    cachePrefixKey(orgId, prefix),
    TTL_SEC,
    async (): Promise<Record<string, string>> => {
      const rows = await prisma.organizationSetting.findMany({
        where: { key: { startsWith: prefix } },
        select: { key: true, value: true },
      });
      const record: Record<string, string> = {};
      for (const r of rows) record[r.key] = r.value;
      return record;
    },
  );
  if (raw instanceof Map) return raw;
  if (raw && typeof raw === "object") {
    return new Map(Object.entries(raw as Record<string, string>));
  }
  return new Map();
}

/**
 * Grava (upsert) e invalida o cache imediatamente. Toda escrita
 * propaga em <100ms entre réplicas via Redis del; sem Redis o cache
 * in-memory é per-process e o TTL de 60s faz a propagação eventual.
 */
export async function setOrgSetting(
  key: string,
  value: string,
): Promise<void> {
  const orgId = getOrgIdOrThrow();
  await prisma.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key } },
    update: { value },
    create: { organizationId: orgId, key, value },
  });
  // Invalida tanto a chave especifica quanto qualquer prefixo cacheado
  // que possa cobri-la. Como nao sabemos os prefixos consumidos, varremos
  // por padrao — o custo e baixo (poucas chaves de prefixo por org).
  await cache.del(cacheKey(orgId, key));
  await cache.delPattern(`org_settings_prefix:${orgId}:*`);
}

export async function deleteOrgSetting(key: string): Promise<void> {
  const orgId = getOrgIdOrThrow();
  await prisma.organizationSetting.deleteMany({
    where: { key },
  });
  await cache.del(cacheKey(orgId, key));
  await cache.delPattern(`org_settings_prefix:${orgId}:*`);
}

/**
 * Variante que aceita default — útil quando a chave pode estar ausente
 * (org nova que ainda não customizou). Atalho idiomático.
 */
export async function getOrgSettingOrDefault<T extends string>(
  key: string,
  defaultValue: T,
): Promise<T> {
  const value = await getOrgSetting(key);
  return (value as T | null) ?? defaultValue;
}

/**
 * Atalho boolean — armazenado como string `"true"`/`"false"`. Qualquer
 * outro valor (incluindo null) cai pro default.
 */
function coerceOrgBool(value: unknown, defaultValue: boolean): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return defaultValue;
}

export async function getOrgSettingBool(
  key: string,
  defaultValue: boolean,
): Promise<boolean> {
  const value = await getOrgSetting(key);
  return coerceOrgBool(value, defaultValue);
}

/**
 * Lê a chave direto no banco, sem o cache de 60s.
 * O motor de distribuição usa isto: um cache antigo de `"true"` (ou o
 * JSON `false` decodificado como boolean, que o coerce antigo tratava
 * como ausente e caía no default ligado) mantinha o toggle desligado
 * na tela e o motor rodando.
 */
export async function getOrgSettingBoolFresh(
  key: string,
  defaultValue: boolean,
): Promise<boolean> {
  const orgId = getOrgIdOrThrow();
  const row = await prisma.organizationSetting.findFirst({
    where: { key, organizationId: orgId },
    select: { value: true },
  });
  return coerceOrgBool(row?.value ?? null, defaultValue);
}

export async function setOrgSettingBool(
  key: string,
  value: boolean,
): Promise<void> {
  return setOrgSetting(key, value ? "true" : "false");
}

// ── Variante para SECRETS (criptografados) ─────────────────────────
//
// Mesma API que getOrgSetting/setOrgSetting, mas o `value` armazenado
// no banco é o ciphertext. Use para chaves de API per-tenant
// (`ai.openai.api_key` por org, `whatsapp_call_secret`, etc.).

export async function getOrgSecretSetting(key: string): Promise<string | null> {
  const raw = await getOrgSetting(key);
  if (!raw) return null;
  try {
    return decryptSecret(raw);
  } catch {
    return null;
  }
}

export async function setOrgSecretSetting(
  key: string,
  value: string,
): Promise<void> {
  return setOrgSetting(key, encryptSecret(value));
}

/**
 * Invalida todo o cache de settings da org corrente. Use quando o
 * caller fez bulk update via SQL/admin sem passar por setOrgSetting.
 */
export async function invalidateOrgSettingsCache(orgId?: string): Promise<void> {
  const id = orgId ?? getOrgIdOrNull();
  if (!id) return;
  await cache.delPattern(`org_setting:${id}:*`);
  await cache.delPattern(`org_settings_prefix:${id}:*`);
}
