/**
 * Alertas de mensagem recebida no inbox, configuráveis pelo ADMIN por
 * departamento e por usuário.
 *
 * Tipos de conversa (para quem recebe):
 *   - `mine`   — atribuída ao usuário;
 *   - `queue`  — sem responsável, num departamento de que ele é membro;
 *   - `others` — qualquer outra que ele pode ver (outro agente, fila da IA).
 *
 * Canais por tipo: `sound` (bip), `toast` (in-page), `native` (notificação
 * do sistema — a da página com a aba oculta E o Web Push/FCM do servidor)
 * e `tab` (contador no título da aba onde a conversa está aberta, fora de
 * foco).
 *
 * Resolução: config do usuário, se existir, vale inteira. Senão, OR dos
 * departamentos CONFIGURADOS de que ele é membro (a mais permissiva).
 * Senão, `DEFAULT_INBOX_ALERT_CONFIG` (comportamento anterior à config).
 *
 * Guardado em `OrganizationSetting`:
 *   `inboxAlerts.department.<departmentId>` e `inboxAlerts.user.<userId>`.
 */

import { z } from "zod";

import { cache } from "@/lib/cache";
import { prismaBase } from "@/lib/prisma-base";

export const INBOX_ALERT_KINDS = ["mine", "queue", "others"] as const;
export type InboxAlertKind = (typeof INBOX_ALERT_KINDS)[number];

export const INBOX_ALERT_CHANNELS = ["sound", "toast", "native", "tab"] as const;
export type InboxAlertChannel = (typeof INBOX_ALERT_CHANNELS)[number];

export type InboxAlertChannels = Record<InboxAlertChannel, boolean>;
export type InboxAlertConfig = Record<InboxAlertKind, InboxAlertChannels>;

export const DEFAULT_INBOX_ALERT_CONFIG: InboxAlertConfig = {
  mine: { sound: true, toast: true, native: true, tab: true },
  queue: { sound: false, toast: true, native: false, tab: false },
  others: { sound: false, toast: false, native: false, tab: false },
};

const channelsSchema = z.object({
  sound: z.boolean(),
  toast: z.boolean(),
  native: z.boolean(),
  tab: z.boolean(),
});

export const inboxAlertConfigSchema = z.object({
  mine: channelsSchema,
  queue: channelsSchema,
  others: channelsSchema,
});

export const INBOX_ALERT_KEY_PREFIX = "inboxAlerts.";
export const inboxAlertDepartmentKey = (id: string) =>
  `${INBOX_ALERT_KEY_PREFIX}department.${id}`;
export const inboxAlertUserKey = (id: string) => `${INBOX_ALERT_KEY_PREFIX}user.${id}`;

export function parseInboxAlertConfig(raw: string | null | undefined): InboxAlertConfig | null {
  if (!raw) return null;
  try {
    const parsed = inboxAlertConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function orConfigs(configs: InboxAlertConfig[]): InboxAlertConfig {
  const out = structuredClone(configs[0]);
  for (const cfg of configs.slice(1)) {
    for (const kind of INBOX_ALERT_KINDS) {
      for (const ch of INBOX_ALERT_CHANNELS) {
        out[kind][ch] ||= cfg[kind][ch];
      }
    }
  }
  return out;
}

export type OrgInboxAlertConfigs = {
  departments: Map<string, InboxAlertConfig>;
  users: Map<string, InboxAlertConfig>;
};

export function resolveInboxAlertConfig(
  configs: OrgInboxAlertConfigs,
  userId: string,
  memberDepartmentIds: readonly string[],
): InboxAlertConfig {
  const own = configs.users.get(userId);
  if (own) return own;
  const fromDepartments = memberDepartmentIds
    .map((id) => configs.departments.get(id))
    .filter((c): c is InboxAlertConfig => Boolean(c));
  if (fromDepartments.length > 0) return orConfigs(fromDepartments);
  return DEFAULT_INBOX_ALERT_CONFIG;
}

const CACHE_TTL_SEC = 60;
const cacheKey = (orgId: string) => `inbox_alert_configs:${orgId}`;

type CachedConfigs = {
  departments: Record<string, InboxAlertConfig>;
  users: Record<string, InboxAlertConfig>;
};

/**
 * Todas as configs da org (poucas linhas). `prismaBase` + org explícita:
 * roda também no webhook/worker (push), sem RequestContext.
 */
export async function loadOrgInboxAlertConfigs(
  organizationId: string,
): Promise<OrgInboxAlertConfigs> {
  const raw = await cache.wrap(
    cacheKey(organizationId),
    CACHE_TTL_SEC,
    async (): Promise<CachedConfigs> => {
      const rows = await prismaBase.organizationSetting.findMany({
        where: { organizationId, key: { startsWith: INBOX_ALERT_KEY_PREFIX } },
        select: { key: true, value: true },
      });
      const out: CachedConfigs = { departments: {}, users: {} };
      for (const row of rows) {
        const cfg = parseInboxAlertConfig(row.value);
        if (!cfg) continue;
        const rest = row.key.slice(INBOX_ALERT_KEY_PREFIX.length);
        if (rest.startsWith("department.")) out.departments[rest.slice(11)] = cfg;
        else if (rest.startsWith("user.")) out.users[rest.slice(5)] = cfg;
      }
      return out;
    },
  );
  return {
    departments: new Map(Object.entries(raw?.departments ?? {})),
    users: new Map(Object.entries(raw?.users ?? {})),
  };
}

export async function invalidateOrgInboxAlertConfigs(organizationId: string) {
  await cache.del(cacheKey(organizationId));
}

/** Config efetiva de um usuário (rota do cliente). */
export async function getEffectiveInboxAlertConfig(params: {
  organizationId: string;
  userId: string;
  memberDepartmentIds: readonly string[];
}): Promise<InboxAlertConfig> {
  const configs = await loadOrgInboxAlertConfigs(params.organizationId);
  return resolveInboxAlertConfig(configs, params.userId, params.memberDepartmentIds);
}
