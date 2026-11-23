/**
 * Configuração do MCP por organização (`OrganizationSetting` key
 * `mcp.config`, JSON). Lida sem cache de propósito: desligar o MCP precisa
 * valer na próxima chamada de ferramenta, em qualquer réplica.
 *
 * `prismaBase` com `organizationId` explícito: a validação de token roda
 * antes de existir RequestContext.
 */
import { loadAuthzContext, can } from "@/lib/authz";
import { logAudit } from "@/lib/audit/log";
import { MCP_DEFAULT_ORG_SCOPES, sanitizeScopes, type McpScope } from "@/lib/mcp/scopes";
import { prismaBase } from "@/lib/prisma-base";

export const MCP_CONFIG_KEY = "mcp.config";

export type McpOrgConfig = {
  enabled: boolean;
  /** Escopos que a organização permite conceder. */
  allowedScopes: McpScope[];
  /** true: qualquer usuário conecta; false: só quem tem `mcp:connect`. */
  allowAllUsers: boolean;
  /** true: telefone/e-mail completos; false (padrão): mascarados. */
  exposeContactPii: boolean;
  /**
   * Campos personalizados (ids de `CustomField`) que o MCP pode ler, além do
   * escopo `custom_fields:read`. Vazio por padrão = nenhum campo sai.
   */
  customFieldIds: string[];
};

function sanitizeIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) if (typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x)) out.add(x);
  return [...out].slice(0, 200);
}

export const DEFAULT_MCP_CONFIG: McpOrgConfig = {
  enabled: false,
  allowedScopes: [...MCP_DEFAULT_ORG_SCOPES],
  allowAllUsers: false,
  exposeContactPii: false,
  customFieldIds: [],
};

export function parseMcpConfig(raw: string | null | undefined): McpOrgConfig {
  if (!raw) return { ...DEFAULT_MCP_CONFIG, allowedScopes: [...DEFAULT_MCP_CONFIG.allowedScopes], customFieldIds: [] };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: j.enabled === true,
      allowedScopes: Array.isArray(j.allowedScopes)
        ? sanitizeScopes(j.allowedScopes)
        : [...MCP_DEFAULT_ORG_SCOPES],
      allowAllUsers: j.allowAllUsers === true,
      exposeContactPii: j.exposeContactPii === true,
      customFieldIds: sanitizeIds(j.customFieldIds),
    };
  } catch {
    return { ...DEFAULT_MCP_CONFIG, allowedScopes: [...MCP_DEFAULT_ORG_SCOPES], customFieldIds: [] };
  }
}

export async function getMcpOrgConfig(organizationId: string): Promise<McpOrgConfig> {
  const row = await prismaBase.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId, key: MCP_CONFIG_KEY } },
    select: { value: true },
  });
  return parseMcpConfig(row?.value);
}

export async function updateMcpOrgConfig(
  organizationId: string,
  actorId: string,
  patch: Partial<McpOrgConfig>,
): Promise<McpOrgConfig> {
  const before = await getMcpOrgConfig(organizationId);
  const next: McpOrgConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : before.enabled,
    allowedScopes:
      patch.allowedScopes !== undefined ? sanitizeScopes(patch.allowedScopes) : before.allowedScopes,
    allowAllUsers:
      typeof patch.allowAllUsers === "boolean" ? patch.allowAllUsers : before.allowAllUsers,
    exposeContactPii:
      typeof patch.exposeContactPii === "boolean" ? patch.exposeContactPii : before.exposeContactPii,
    customFieldIds:
      patch.customFieldIds !== undefined ? sanitizeIds(patch.customFieldIds) : before.customFieldIds,
  };
  const value = JSON.stringify(next);
  await prismaBase.organizationSetting.upsert({
    where: { organizationId_key: { organizationId, key: MCP_CONFIG_KEY } },
    update: { value },
    create: { organizationId, key: MCP_CONFIG_KEY, value },
  });
  await logAudit({
    entity: "settings",
    action: "update",
    entityId: MCP_CONFIG_KEY,
    organizationId,
    actorId,
    before,
    after: next,
  });
  return next;
}

export type McpEligibilityUser = {
  id: string;
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

/**
 * Pode conectar um cliente MCP (consentimento) e continuar usando a conexão.
 * Super-admin não ganha bypass aqui: o MCP sempre opera dentro da org.
 */
export async function canUserConnectMcp(
  user: McpEligibilityUser,
  config?: McpOrgConfig,
): Promise<{ ok: true; config: McpOrgConfig } | { ok: false; reason: string; config: McpOrgConfig }> {
  if (!user.organizationId) {
    return { ok: false, reason: "no_organization", config: config ?? DEFAULT_MCP_CONFIG };
  }
  const cfg = config ?? (await getMcpOrgConfig(user.organizationId));
  if (!cfg.enabled) return { ok: false, reason: "mcp_disabled", config: cfg };
  if (cfg.allowedScopes.length === 0) return { ok: false, reason: "no_scopes", config: cfg };
  if (cfg.allowAllUsers) return { ok: true, config: cfg };
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: false,
  });
  if (can(ctx, "mcp:connect") || can(ctx, "mcp:manage")) return { ok: true, config: cfg };
  return { ok: false, reason: "missing_permission", config: cfg };
}
