/**
 * Especificações de cache das rotas que o app chama ao abrir uma aba.
 *
 * Cada função devolve a `CachedResponseSpec` (ver `lib/cache/response-cache.ts`)
 * de UMA rota para UM usuário: org, famílias de versão, variante (as entradas
 * exatas que mudam o corpo) e o loader com o MESMO corpo que a rota devolvia.
 * A rota individual e o bootstrap (`GET /api/me/bootstrap`, campo `blocks`)
 * usam a mesma função — por isso o corpo do bloco é idêntico ao da rota e o
 * cache é compartilhado entre os dois caminhos.
 *
 * `null` = não cacheável para este usuário (sem org — super-admin puro — ou
 * sem permissão): a rota segue o caminho antigo e o bootstrap não manda o bloco.
 *
 * As checagens de permissão das rotas continuam nas rotas; aqui só entra o
 * que muda o CONTEÚDO.
 */
import { Prisma } from "@prisma/client";

import { canViewPipeline, canViewStage, loadAuthzContext } from "@/lib/authz";
import { listAllowedPipelineIds } from "@/lib/authz/resource-policy";
import {
  RESPONSE_FAMILIES,
  type CachedResponseSpec,
} from "@/lib/cache/response-cache";
import { userOrgFilter } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { getOrgSetting, getOrgSettingsByPrefix } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { getVisibilitySettings } from "@/lib/visibility";
import {
  getProvisioningStatusMany,
  type ProvisionStatus,
} from "@/services/api4com/provisioning";
import { getChannels } from "@/services/channels";
import { listLossReasons } from "@/services/loss-reasons";
import { getPipelines } from "@/services/pipelines";
import { getQuickReplies } from "@/services/quick-replies";
import { getSystemPresenceMap } from "@/services/system-presence";

const log = getLogger("startup-cache");

/** O mínimo da sessão (ou do token) que as especificações usam. */
export type StartupCacheUser = {
  id: string;
  role?: string | null;
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

function orgOf(user: StartupCacheUser): string | null {
  return user.organizationId ?? null;
}

function sortedOrNull(values: Iterable<string> | null | undefined): string[] | null {
  return values ? [...values].sort() : null;
}

// ── GET /api/channels ───────────────────────────────────────────────

export function channelsSpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "channels",
    orgId,
    families: [RESPONSE_FAMILIES.channels],
    load: async () => ({ channels: await getChannels() }),
  };
}

// ── GET /api/quick-replies ──────────────────────────────────────────

export function quickRepliesSpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "quick_replies",
    orgId,
    families: [RESPONSE_FAMILIES.quickReplies],
    load: () => getQuickReplies(),
  };
}

// ── GET /api/settings/quick-replies/groups ──────────────────────────

/** Corpo de `GET /api/settings/quick-replies/groups` (vazio sem a tabela). */
export async function loadQuickReplyGroups(orgId: string): Promise<unknown> {
  try {
    return await prisma.quickReplyGroup.findMany({
      where: { organizationId: orgId },
      orderBy: { order: "asc" },
      include: { _count: { select: { quickReplies: true } } },
    });
  } catch {
    // Tabela ainda não existe (migration pendente) — lista vazia.
    return [];
  }
}

export function quickReplyGroupsSpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "quick_reply_groups",
    orgId,
    // `_count.quickReplies` muda com as respostas: mesma família.
    families: [RESPONSE_FAMILIES.quickReplies],
    load: () => loadQuickReplyGroups(orgId),
  };
}

// ── GET /api/pipelines ──────────────────────────────────────────────

/**
 * Variante = entradas que filtram funis/etapas: escopo granular (ids
 * permitidos) e negações/allow-list de etapa do papel. ADMIN vê tudo.
 *
 * `dealCount` por etapa vai junto no corpo (contrato da rota) e só é
 * recalculado em mudança de funil/etapa ou no TTL — nenhuma tela do
 * frontend usa esse número. Chamadas com token (n8n) não passam por aqui.
 */
export async function pipelinesSpec(user: StartupCacheUser): Promise<CachedResponseSpec | null> {
  const orgId = orgOf(user);
  if (!orgId) return null;
  const [allowedPipelineIds, authz] = await Promise.all([
    listAllowedPipelineIds({ ...user, organizationId: orgId }),
    loadAuthzContext({
      userId: user.id,
      organizationId: orgId,
      isSuperAdmin: Boolean(user.isSuperAdmin),
    }),
  ]);
  const sees = authz.isSuperAdmin || authz.isAdmin;
  const variant = JSON.stringify({
    allowed: sortedOrNull(allowedPipelineIds),
    admin: sees,
    pipelineDeny: sees ? null : sortedOrNull(authz.pipelineDeny),
    stageDeny: sees ? null : sortedOrNull(authz.stageDeny),
    stageView: sees ? null : sortedOrNull(authz.stageView),
  });
  return {
    name: "pipelines",
    orgId,
    families: [RESPONSE_FAMILIES.pipelines],
    variant,
    load: async () => {
      const pipelines = await getPipelines({ allowedPipelineIds });
      return pipelines
        .filter((p) => canViewPipeline(authz, p.id))
        .map((p) => ({
          ...p,
          stages: p.stages.filter((s) => canViewStage(authz, s.id)),
        }))
        .filter((p) => p.stages.length > 0);
    },
  };
}

// ── GET /api/custom-fields/card-extension ───────────────────────────

const CARD_EXTENSION_KEY = "customFields.cardExtension";

export type CardExtensionField = {
  id: string;
  label: string;
  entity: string;
  type: string;
  options: string[];
  highlightRules: unknown;
};

export function parseCardExtensionIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

export async function resolveCardExtensionFields(ids: string[]): Promise<CardExtensionField[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.customField.findMany({
    where: { id: { in: ids }, entity: { in: ["deal", "contact"] } },
    select: { id: true, label: true, entity: true, type: true, options: true, highlightRules: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        label: row.label,
        entity: row.entity,
        type: row.type,
        options: row.options,
        highlightRules: row.highlightRules,
      },
    ];
  });
}

export function cardExtensionSpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "card_extension",
    orgId,
    // Lista de ids em `OrganizationSetting` + definições dos campos.
    families: [RESPONSE_FAMILIES.orgSettings, RESPONSE_FAMILIES.customFields],
    load: async () =>
      resolveCardExtensionFields(parseCardExtensionIds(await getOrgSetting(CARD_EXTENSION_KEY))),
  };
}

export const CARD_EXTENSION_SETTING_KEY = CARD_EXTENSION_KEY;

// ── GET /api/settings/visibility ────────────────────────────────────

export function visibilitySpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "visibility",
    orgId,
    families: [RESPONSE_FAMILIES.orgSettings],
    load: () => getVisibilitySettings(),
  };
}

// ── GET /api/settings/org?key= | ?prefix= ───────────────────────────

/**
 * A checagem de papel (MEMBER só lê prefixos liberados) fica na rota; a
 * resposta não depende de quem pede, só da query.
 */
export function orgSettingSpec(
  user: StartupCacheUser,
  query: { key: string } | { prefix: string },
): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  if ("key" in query) {
    const key = query.key;
    return {
      name: "org_setting",
      orgId,
      families: [RESPONSE_FAMILIES.orgSettings],
      variant: `key=${key}`,
      load: async () => ({ key, value: await getOrgSetting(key) }),
    };
  }
  const prefix = query.prefix;
  return {
    name: "org_setting",
    orgId,
    families: [RESPONSE_FAMILIES.orgSettings],
    variant: `prefix=${prefix}`,
    load: async () => Object.fromEntries(await getOrgSettingsByPrefix(prefix)),
  };
}

// ── GET /api/settings/loss-reasons ──────────────────────────────────

export function lossReasonsSpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "loss_reasons",
    orgId,
    families: [RESPONSE_FAMILIES.lossReasons],
    load: () => listLossReasons(),
  };
}

// ── GET /api/settings/departments ───────────────────────────────────

function isManagerUp(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "MANAGER";
}

/**
 * Corpo de `GET /api/settings/departments` para o papel. `openCounts: false`
 * (variante estável, `x-bootstrap-version: 2`): ADMIN/MANAGER recebem o
 * mesmo corpo sem `_count.conversations` — a contagem de abertas vem de
 * `GET /api/me/live` (`departmentCounts`).
 */
export async function loadDepartments(
  orgId: string,
  managerUp: boolean,
  { openCounts = true }: { openCounts?: boolean } = {},
): Promise<unknown> {
  if (!managerUp) {
    return prisma.department.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        color: true,
        icon: true,
        // Necessário no inbox: após "Distribuir p/ departamento", o FE
        // atualiza o sticky com o flag de tabulação do novo depto.
        requireTabulationOnClose: true,
      },
      orderBy: { name: "asc" },
    });
  }
  try {
    return await prisma.department.findMany({
      where: { organizationId: orgId },
      include: {
        _count: {
          select: openCounts
            ? { conversations: { where: { status: "OPEN" } }, members: true }
            : { members: true },
        },
      },
      orderBy: { name: "asc" },
    });
  } catch {
    if (!openCounts) {
      try {
        return await prisma.department.findMany({
          where: { organizationId: orgId },
          orderBy: { name: "asc" },
        });
      } catch {
        return [];
      }
    }
    // A contagem de `members` depende da tabela `department_members`
    // (migração add_department_members). Se ela ainda não existe neste
    // ambiente, NÃO escondemos todos os departamentos — reconsultamos
    // sem o _count.members (só conversas), pra a tela continuar viva.
    try {
      return await prisma.department.findMany({
        where: { organizationId: orgId },
        include: {
          _count: { select: { conversations: { where: { status: "OPEN" } } } },
        },
        orderBy: { name: "asc" },
      });
    } catch {
      // Nem a tabela de departamentos existe ainda — lista vazia.
      return [];
    }
  }
}

/**
 * MEMBER: só id/nome/cor/ícone (estável). ADMIN/MANAGER: também o total de
 * conversas abertas por departamento — por isso a família `inbox_tab_counts`
 * (sobe quando um ticket muda de aba/status/departamento, no máximo a cada
 * 15 s por org) entra na chave dessa variante.
 */
export function departmentsSpec(
  user: StartupCacheUser,
  { stable = false }: { stable?: boolean } = {},
): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  const managerUp = isManagerUp(user.role);
  if (managerUp && stable) {
    // Estável (v2): sem contagem de abertas, então sem `inbox_tab_counts`.
    return {
      name: "departments",
      orgId,
      families: [RESPONSE_FAMILIES.departments],
      variant: "manager_stable",
      load: () => loadDepartments(orgId, true, { openCounts: false }),
    };
  }
  return {
    name: "departments",
    orgId,
    families: managerUp
      ? [RESPONSE_FAMILIES.departments, RESPONSE_FAMILIES.inboxTabCounts]
      : [RESPONSE_FAMILIES.departments],
    variant: managerUp ? "manager" : "member",
    load: () => loadDepartments(orgId, managerUp),
  };
}

// ── GET /api/field-layout?context=…[&forUser=true] ──────────────────

export function isMissingFieldLayoutTable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2021" &&
    String(error.meta?.table ?? "").includes("field_layout_configs")
  );
}

/** Corpo de `GET /api/field-layout` (sem a tabela: tudo `null`). */
export async function loadFieldLayout(
  orgId: string,
  userId: string,
  context: string,
  forUser: boolean,
): Promise<{ admin: unknown; agent: unknown }> {
  try {
    const adminConfig = await prisma.fieldLayoutConfig.findFirst({
      where: { organizationId: orgId, context, userId: null },
    });
    const agentConfig = forUser
      ? await prisma.fieldLayoutConfig.findFirst({
          where: { organizationId: orgId, context, userId },
        })
      : null;
    return {
      admin: adminConfig?.sections ?? null,
      agent: agentConfig?.sections ?? null,
    };
  } catch (error) {
    if (isMissingFieldLayoutTable(error)) return { admin: null, agent: null };
    throw error;
  }
}

/** Com `forUser`, o layout do próprio usuário entra: variante por usuário. */
export function fieldLayoutSpec(
  user: StartupCacheUser,
  context: string,
  forUser: boolean,
): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "field_layout",
    orgId,
    families: [RESPONSE_FAMILIES.fieldLayout],
    variant: JSON.stringify({ context, user: forUser ? user.id : null }),
    load: () => loadFieldLayout(orgId, user.id, context, forUser),
  };
}

// ── GET /api/settings/quick-replies (sem filtro) ────────────────────

/** Corpo de `GET /api/settings/quick-replies` sem `groupId`/`q`. */
export async function loadSettingsQuickReplies(orgId: string): Promise<unknown> {
  try {
    return await prisma.quickReply.findMany({
      where: { organizationId: orgId },
      orderBy: { position: "asc" },
      include: { group: { select: { id: true, name: true } } },
    });
  } catch {
    // group relation may not exist yet (migration pending) — try without include.
    const replies = await prisma.quickReply.findMany({
      where: { organizationId: orgId },
      orderBy: { position: "asc" },
    });
    return replies.map((r) => ({ ...r, group: null }));
  }
}

/** Só a lista inteira (sem `groupId`/`q`) é cacheada — é a que o composer pede. */
export function settingsQuickRepliesSpec(user: StartupCacheUser): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  return {
    name: "settings_quick_replies",
    orgId,
    families: [RESPONSE_FAMILIES.quickReplies],
    load: () => loadSettingsQuickReplies(orgId),
  };
}

// ── GET /api/users[?includeAi=1] ────────────────────────────────────

/**
 * TTL curto (60 s) e não 10 min: o corpo traz presença de uso
 * (`systemOnline`/`lastSeenAt`), que muda com o tempo e com o heartbeat das
 * abas — não há escrita para invalidar. O resto invalida na hora: cadastro
 * e papel pela família `rc_users` (+ `authz` para nomes de funções), status
 * de agente por `rc_agent_status`. O frontend já tratava a lista como fresca
 * por 60 s. Só vale para a variante legada; a estável (v2) usa 10 min.
 */
export const USERS_RESPONSE_TTL_SEC = 60;

/**
 * Campos de `GET /api/users` que mudam sem ação administrativa: status do
 * agente (o próprio agente / a distribuição), presença de uso (heartbeat
 * das abas). A variante estável (`x-bootstrap-version: 2`) sai sem eles;
 * vêm de `GET /api/me/live` em `usersPresence[userId]`.
 */
export const USERS_VOLATILE_FIELDS = ["agentStatus", "systemOnline", "lastSeenAt"] as const;

/**
 * Corpo de `GET /api/users` (`includeAi` = `?includeAi=1`). `stable`: sem
 * `USERS_VOLATILE_FIELDS` (nem a consulta de presença).
 */
export async function loadUsersList(
  user: StartupCacheUser,
  includeAi: boolean,
  { stable = false }: { stable?: boolean } = {},
): Promise<unknown[]> {
  const orgFilter = userOrgFilter({
    user: { organizationId: user.organizationId, isSuperAdmin: Boolean(user.isSuperAdmin) },
  });
  const users = await prisma.user.findMany({
    // Por padrão só humanos (Equipe / filtros). Com ?includeAi=1 inclui
    // agentes IA ativos — usado nos seletores de responsável (1º atendimento).
    // Exclui anonimizados (soft-delete da Equipe / LGPD).
    where: includeAi
      ? {
          ...orgFilter,
          isErased: false,
          OR: [
            { type: "HUMAN" },
            { type: "AI", aiAgentConfig: { active: true } },
          ],
        }
      : { type: "HUMAN", isErased: false, ...orgFilter },
    orderBy: { name: "asc" },
    select: {
      id: true,
      number: true,
      name: true,
      email: true,
      role: true,
      type: true,
      avatarUrl: true,
      phone: true,
      // Só para achar o ramal na org do usuário (telefonia); sai da resposta.
      organizationId: true,
      // Roles RBAC atribuídas (modelo novo). Usado pela tela de Equipe
      // para exibir a "função" como role customizada (mantendo só ADMIN
      // como preset). NÃO substitui `role` legado — coexistem.
      roleAssignments: {
        select: {
          role: { select: { id: true, name: true, systemPreset: true } },
        },
      },
      ...(stable
        ? {}
        : {
            agentStatus: {
              select: {
                status: true,
                availableForVoiceCalls: true,
                updatedAt: true,
              },
            },
          }),
    },
  });

  // Presença de USO (aba do CRM aberta) — SEPARADA de agentStatus.
  // agentStatus continua refletindo apenas a disponibilidade manual
  // da Distribuição. Nunca combinar esses dois conceitos.
  const orgId = user.organizationId;
  let presence: Awaited<ReturnType<typeof getSystemPresenceMap>> = new Map();
  if (orgId && !stable) {
    try {
      presence = await getSystemPresenceMap({
        organizationId: orgId,
        userIds: users.map((u) => u.id),
      });
    } catch {
      // Migration ainda não aplicada / erro transiente: seguimos sem presença.
    }
  }

  // Telefonia de cada usuário (evita 1 GET /api/users/:id/telephony por
  // linha na tela de Equipe). Mesma regra da rota por id: só ADMIN lê; os
  // demais recebem a lista SEM o campo `telephony`. Para ADMIN o campo é o
  // mesmo objeto da rota por id, ou `null` onde ela daria 404 (usuário sem
  // org). Uma consulta para a lista inteira.
  const canReadTelephony = user.role === "ADMIN";
  let telephony: Map<string, ProvisionStatus> | null = null;
  if (canReadTelephony) {
    try {
      telephony = await getProvisioningStatusMany(users);
    } catch (err) {
      // Falha na telefonia não derruba a lista: o front cai na rota por id.
      log.warn({ err }, "GET /api/users: telefonia em lote falhou");
    }
  }

  // Achata `roleAssignments` em `assignedRoles` (lista limpa pra UI).
  const shaped = users.map((u) => {
    const { roleAssignments, organizationId: _organizationId, ...rest } = u;
    const p = presence.get(u.id);
    if (stable) {
      return {
        ...rest,
        assignedRoles: roleAssignments.map((a) => a.role),
        ...(telephony ? { telephony: telephony.get(u.id) ?? null } : {}),
      };
    }
    return {
      ...rest,
      assignedRoles: roleAssignments.map((a) => a.role),
      systemOnline: p?.systemOnline ?? false,
      lastSeenAt: p?.lastSeenAt ? p.lastSeenAt.toISOString() : null,
      ...(telephony ? { telephony: telephony.get(u.id) ?? null } : {}),
    };
  });

  return shaped;
}

/**
 * Variante: `includeAi` + se quem pede é ADMIN (só ADMIN recebe `telephony`).
 *
 * `stable` (`x-bootstrap-version: 2`): entrada separada (`users_v2`), sem
 * `USERS_VOLATILE_FIELDS`, só com `rc_users` + `authz` e TTL de 10 min — o
 * status de agente sobe `rc_agent_status`, que só a variante legada lê.
 */
export function usersSpec(
  user: StartupCacheUser,
  includeAi: boolean,
  { stable = false }: { stable?: boolean } = {},
): CachedResponseSpec | null {
  const orgId = orgOf(user);
  if (!orgId) return null;
  const variant = JSON.stringify({ includeAi, telephony: user.role === "ADMIN" });
  if (stable) {
    return {
      name: "users_v2",
      orgId,
      families: [RESPONSE_FAMILIES.users, RESPONSE_FAMILIES.authz],
      variant,
      load: () => loadUsersList(user, includeAi, { stable: true }),
    };
  }
  return {
    name: "users",
    orgId,
    families: [RESPONSE_FAMILIES.users, RESPONSE_FAMILIES.authz, RESPONSE_FAMILIES.agentStatus],
    variant,
    ttlSec: USERS_RESPONSE_TTL_SEC,
    load: () => loadUsersList(user, includeAi),
  };
}
