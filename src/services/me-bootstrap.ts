/**
 * Bootstrap do shell — `GET /api/me/bootstrap`.
 *
 * Agrega, numa única resposta, os payloads que o shell do frontend hoje
 * busca em ~10 requisições separadas na carga de qualquer rota
 * (auditoria A2 / FE-13). Cada bloco reutiliza o serviço que a rota
 * original já chama e aplica a MESMA checagem de permissão dessa rota;
 * quando o usuário não pode ver o bloco, ele vem `null` (nunca 403 no
 * agregado). Um bloco que falhar também vem `null` e o nome entra em
 * `failedBlocks` — o frontend pode então cair na rota individual.
 *
 * Blocos e rota espelhada:
 *   profile              GET /api/profile
 *   preferences          GET /api/profile/preferences
 *   effectivePermissions GET /api/users/:me/effective-permissions
 *   organization         GET /api/organization
 *   alertConfig          GET /api/agents/me/alert-config
 *   agentStatus          GET /api/agents/:me/status
 *   emailUnread          GET /api/email-accounts   (só id/e-mail/unreadCount)
 *   teamChatRooms        GET /api/team-chat/rooms  (só resumo por sala)
 *   widgets              GET /api/widgets          (só slugs ativos)
 *
 * Fora do bootstrap (de propósito):
 *   - /api/sip-extensions/me/credentials — senha SIP em claro; nunca
 *     entra num agregado (nem no hash do ETag).
 *   - /api/app-revision — é rota do frontend, não deste backend.
 *   - Catálogo completo de widgets (`/api/widgets` devolve o catálogo
 *     inteiro com estado); o shell só precisa dos slugs ativos.
 *   - Listas de contatos/deals/conversas e contadores do inbox — caros e
 *     voláteis; continuam nos endpoints próprios.
 *
 * O ETag é um hash estável do JSON (sem timestamps), então o cliente que
 * manda `If-None-Match` recebe 304 sem corpo quando nada mudou.
 *
 * Estável × volátil (14/10/2026):
 *   - estável (bootstrap v2, cacheado por usuário — `me-bootstrap-cache.ts`):
 *     user, profile, preferences, effectivePermissions, organization,
 *     alertConfig, widgets. Mudam só por escrita (do usuário ou de admin).
 *   - volátil (`GET /api/me/live`, `buildMeLive`): agentStatus (o usuário
 *     troca Online/Ausente; a distribuição também), emailUnread (chega
 *     e-mail), teamChatRooms (chega mensagem: `unread`, `lastMessageAt`,
 *     `lastPreview`) — e o bloco `/api/team-chat/rooms`, que sai da mesma
 *     consulta.
 *   - v1 (sem `x-bootstrap-version: 2`) continua com tudo, para o frontend
 *     atual durante a transição.
 */

import { createHash } from "node:crypto";

import { Prisma, type UserRole } from "@prisma/client";

import { userOrgFilter } from "@/lib/auth-helpers";
import type { BootstrapBlockUrl } from "@/services/bootstrap-blocks";
import { can, loadAuthzContext, requirePermission } from "@/lib/authz";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  DEFAULT_INBOX_ALERT_CONFIG,
  getEffectiveInboxAlerts,
  type InboxAlertConfig,
  type InboxTabAudience,
} from "@/lib/inbox-alert-config";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import {
  listEmailAccounts,
  resolveEmailAccess,
} from "@/services/email-accounts";
import {
  computeEffectivePermissions,
  type EffectivePermissionsPayload,
} from "@/services/effective-permissions";
import { getActiveWidgetSlugs } from "@/services/organization-widgets";
import { getOrganizationSummary } from "@/services/organization-summary";
import { listRooms } from "@/services/team-chat";
import {
  computeAvailableKeys,
  getAppearancePreferences,
  getDashboardPreferences,
  getSidebarPreferenceBundle,
  type AppearancePreferences,
  type DashboardPreferences,
  type SidebarPreferences,
} from "@/services/user-preferences";
import { getLogger } from "@/lib/logger";

const log = getLogger("me-bootstrap");

// ──────────────────────────────────────────────
// Tipos do contrato
// ──────────────────────────────────────────────

export type MeBootstrapUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: UserRole;
  organizationId: string | null;
  isSuperAdmin: boolean;
};

/** Mesmo shape de `GET /api/profile`. */
export type BootstrapProfile = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatarUrl: string | null;
  phone: string | null;
  signature: string | null;
  closingMessage: string | null;
  createdAt: Date;
  chatTheme: string;
};

/** Mesmo shape de `GET /api/profile/preferences`. */
export type BootstrapPreferences = {
  sidebar: SidebarPreferences;
  roleSidebar: SidebarPreferences | null;
  dashboard: DashboardPreferences;
  appearance: AppearancePreferences;
  availableKeys: string[];
};

/** Mesmo shape de `GET /api/organization`. */
export type BootstrapOrganization = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string | null;
  status: string;
  onboardingCompletedAt: Date | null;
};

/** Mesmo shape de `GET /api/agents/me/alert-config`. */
export type BootstrapAlertConfig = {
  config: InboxAlertConfig;
  departmentIds: string[];
  /** Público do aviso na aba (org); `null` = coluna "Aba" por tipo. */
  tabAudience: InboxTabAudience | null;
};

/** Mesmo shape de `GET /api/agents/:id/status` (fallback OFFLINE incluso). */
export type BootstrapAgentStatus = {
  userId: string;
  status: string;
  availableForVoiceCalls: boolean;
  [key: string]: unknown;
};

/** Resumo de `GET /api/email-accounts`: só o que o badge do shell usa. */
export type BootstrapEmailUnread = {
  totalUnread: number;
  accounts: { id: string; email: string; unreadCount: number }[];
};

/** Resumo de `GET /api/team-chat/rooms`: só o que o badge/lista do shell usa. */
export type BootstrapTeamChatRooms = {
  totalUnread: number;
  rooms: {
    id: string;
    kind: "DM" | "GROUP" | "CHANNEL";
    name: string;
    unread: number;
    muted: boolean;
    lastMessageAt: string;
    lastPreview: string | null;
  }[];
};

/** Widgets habilitados na org (slugs), derivado de `GET /api/widgets`. */
export type BootstrapWidgets = {
  activeSlugs: string[];
};

export type MeBootstrapPayload = {
  version: 1;
  user: { id: string; organizationId: string | null; isSuperAdmin: boolean };
  profile: BootstrapProfile | null;
  preferences: BootstrapPreferences | null;
  effectivePermissions: EffectivePermissionsPayload | null;
  organization: BootstrapOrganization | null;
  alertConfig: BootstrapAlertConfig | null;
  agentStatus: BootstrapAgentStatus | null;
  emailUnread: BootstrapEmailUnread | null;
  teamChatRooms: BootstrapTeamChatRooms | null;
  widgets: BootstrapWidgets | null;
  /** Blocos que lançaram erro (vieram `null` por falha, não por permissão). */
  failedBlocks: BootstrapBlockName[];
};

/** Campos voláteis: fora do bootstrap v2, em `GET /api/me/live`. */
export const ME_LIVE_FIELDS = ["agentStatus", "emailUnread", "teamChatRooms"] as const;

/**
 * Payload base do bootstrap v2 (`x-bootstrap-version: 2`): o v1 sem os
 * campos voláteis (`ME_LIVE_FIELDS`). Mesma forma em cada campo.
 */
export type MeBootstrapStablePayload = Omit<
  MeBootstrapPayload,
  "version" | (typeof ME_LIVE_FIELDS)[number]
> & { version: 2 };

/** Corpo de `GET /api/me/live` (sem `blocks`, que a rota acrescenta). */
export type MeLivePayload = Pick<MeBootstrapPayload, (typeof ME_LIVE_FIELDS)[number]> & {
  version: 1;
  /** Blocos voláteis que falharam (vieram `null` por erro). */
  failedBlocks: BootstrapBlockName[];
};

/**
 * Corpo completo de `GET /api/me/bootstrap`: o payload base +
 *
 * - `blocks`: `{ [url]: <corpo idêntico ao de GET url> }`, onde `url` é
 *   EXATAMENTE o path+query que o frontend chama na inicialização
 *   (`BOOTSTRAP_BLOCK_URLS` em `services/bootstrap-blocks.ts`). URL ausente =
 *   sem permissão/sem org → o frontend chama a rota individual.
 * - `blockErrors`: URLs cujo bloco falhou (idem: rota individual).
 *
 * Os blocos saem do mesmo cache das rotas (`services/startup-cache.ts`).
 */
export type MeBootstrapResponse = MeBootstrapPayload & {
  blocks: Partial<Record<BootstrapBlockUrl, unknown>>;
  blockErrors: BootstrapBlockUrl[];
};

export type BootstrapBlockName =
  | "profile"
  | "preferences"
  | "effectivePermissions"
  | "organization"
  | "alertConfig"
  | "agentStatus"
  | "emailUnread"
  | "teamChatRooms"
  | "widgets";

// ──────────────────────────────────────────────
// Blocos
// ──────────────────────────────────────────────

/** Espelha `PROFILE_SELECT` de `app/api/profile/route.ts`. */
const PROFILE_SELECT_CORE = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarUrl: true,
  phone: true,
  signature: true,
  closingMessage: true,
  createdAt: true,
} as const;

const PROFILE_SELECT = { ...PROFILE_SELECT_CORE, chatTheme: true } as const;

const DEFAULT_CHAT_THEME_DB = "azul";

function isMissingUserChatThemeColumn(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2022") return true;
  }
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    msg.includes("chattheme") ||
    msg.includes("chat_theme") ||
    (msg.includes("column") && msg.includes("does not exist"))
  );
}

async function loadProfile(userId: string): Promise<BootstrapProfile | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT,
    });
    return user as BootstrapProfile | null;
  } catch (e) {
    if (!isMissingUserChatThemeColumn(e)) throw e;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: PROFILE_SELECT_CORE,
    });
    return user ? { ...user, chatTheme: DEFAULT_CHAT_THEME_DB } : null;
  }
}

async function loadPreferences(
  user: MeBootstrapUser,
  activeSlugs: Set<string>,
): Promise<BootstrapPreferences> {
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  });
  const availableKeys = computeAvailableKeys(
    (key) => can(ctx, key),
    (slug) => activeSlugs.has(slug),
  );
  const [sidebarBundle, dashboard, appearance] = await Promise.all([
    getSidebarPreferenceBundle(user.id, availableKeys),
    getDashboardPreferences(user.id),
    getAppearancePreferences(user.id),
  ]);
  return {
    sidebar: sidebarBundle.sidebar,
    roleSidebar: sidebarBundle.roleSidebar,
    dashboard,
    appearance,
    availableKeys: [...availableKeys],
  };
}

async function loadEffectivePermissions(
  user: MeBootstrapUser,
): Promise<EffectivePermissionsPayload | null> {
  // Igual à rota: o alvo (aqui, o próprio usuário) é lido com
  // `userOrgFilter` na base sem escopo — super-admin sem org ativa
  // também precisa se enxergar. Comentário obrigatório (AGENTS.md).
  const row = await prismaBase.user.findFirst({
    where: { id: user.id, ...userOrgFilter({ user }) },
    select: { id: true, role: true, organizationId: true, isSuperAdmin: true },
  });
  if (!row) return null;
  return computeEffectivePermissions(row);
}

/**
 * Mesmos campos do `ORG_SELECT` de `app/api/organization/route.ts` — o
 * select mora em `services/organization-summary.ts`.
 */
async function loadOrganization(
  organizationId: string | null,
): Promise<BootstrapOrganization | null> {
  if (!organizationId) return null;
  // Memória do processo por 30 s (invalidada quando a org é editada).
  return getOrganizationSummary(organizationId);
}

async function loadAlertConfig(user: MeBootstrapUser): Promise<BootstrapAlertConfig> {
  const organizationId = user.organizationId;
  if (!organizationId) {
    return { config: DEFAULT_INBOX_ALERT_CONFIG, departmentIds: [], tabAudience: null };
  }
  const rows = await prisma.departmentMember.findMany({
    where: { userId: user.id, organizationId },
    select: { departmentId: true },
  });
  const departmentIds = rows.map((r) => r.departmentId);
  const { config, tabAudience } = await getEffectiveInboxAlerts({
    organizationId,
    userId: user.id,
    memberDepartmentIds: departmentIds,
  });
  return { config, departmentIds, tabAudience };
}

async function loadAgentStatus(userId: string): Promise<BootstrapAgentStatus> {
  const agentStatus = await prisma.agentStatus.findUnique({ where: { userId } });
  return (
    (agentStatus as BootstrapAgentStatus | null) ?? {
      userId,
      status: "OFFLINE",
      availableForVoiceCalls: false,
    }
  );
}

async function loadEmailUnread(
  user: MeBootstrapUser,
): Promise<BootstrapEmailUnread | null> {
  const access = await resolveEmailAccess(user);
  if (!access.canViewShared && !access.canViewOwn) {
    const denied = await requirePermission(user, "email_account:view");
    if (denied) return null;
  }
  const accounts = await listEmailAccounts(access);
  const summary = accounts.map((a) => ({
    id: a.id,
    email: a.email,
    unreadCount: a.unreadCount,
  }));
  return {
    totalUnread: summary.reduce((sum, a) => sum + a.unreadCount, 0),
    accounts: summary,
  };
}

async function loadTeamChatRooms(
  user: MeBootstrapUser,
  onFullRooms?: (rooms: unknown[]) => void,
): Promise<BootstrapTeamChatRooms | null> {
  if (!user.organizationId) return null;
  const denied = await requirePermissionForUser(
    {
      id: user.id,
      role: user.role,
      organizationId: user.organizationId,
      isSuperAdmin: user.isSuperAdmin,
    },
    "team_chat:view",
  );
  if (denied) return null;
  const rooms = await listRooms({
    userId: user.id,
    organizationId: user.organizationId,
  });
  // Lista completa (corpo de `GET /api/team-chat/rooms`) para o bloco
  // `/api/team-chat/rooms` do bootstrap — a mesma consulta, sem repetir.
  onFullRooms?.(rooms);
  const summary = rooms.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    unread: r.unread,
    muted: r.muted,
    lastMessageAt: r.lastMessageAt,
    lastPreview: r.lastPreview,
  }));
  return {
    totalUnread: summary.reduce((sum, r) => sum + (r.muted ? 0 : r.unread), 0),
    rooms: summary,
  };
}

// ──────────────────────────────────────────────
// Montagem
// ──────────────────────────────────────────────

async function settle<T>(
  name: BootstrapBlockName,
  failed: BootstrapBlockName[],
  fn: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    failed.push(name);
    log.error(
      { bloco: name, err: e instanceof Error ? e.message : e },
      "[me-bootstrap] bloco falhou",
    );
    return null;
  }
}

/**
 * Monta o payload completo. Precisa do `RequestContext` ativo
 * (`withOrgContext`/`requireAuth`) porque os serviços usam `prisma` scoped.
 */
export type BuildMeBootstrapHooks = {
  /** Recebe a lista completa das salas (mesma de `GET /api/team-chat/rooms`). */
  onTeamChatRooms?: (rooms: unknown[]) => void;
};

export async function buildMeBootstrap(
  user: MeBootstrapUser,
  hooks: BuildMeBootstrapHooks = {},
): Promise<MeBootstrapPayload> {
  const failed: BootstrapBlockName[] = [];
  const [stable, live] = await Promise.all([
    loadStableParts(user, failed),
    loadLiveParts(user, failed, hooks),
  ]);
  // Ordem das chaves = contrato v1 (o ETag v1 é hash do JSON).
  return {
    version: 1,
    user: bootstrapUser(user),
    profile: stable.profile,
    preferences: stable.preferences,
    effectivePermissions: stable.effectivePermissions,
    organization: stable.organization,
    alertConfig: stable.alertConfig,
    agentStatus: live.agentStatus,
    emailUnread: live.emailUnread,
    teamChatRooms: live.teamChatRooms,
    widgets: stable.widgets,
    failedBlocks: failed.sort(),
  };
}

/**
 * Payload ESTÁVEL (bootstrap v2, header `x-bootstrap-version: 2`): só o que
 * muda por ação administrativa ou do próprio usuário. Cacheado por usuário
 * em `services/me-bootstrap-cache.ts`. Sem `agentStatus`, `emailUnread` e
 * `teamChatRooms` — esses vêm de `GET /api/me/live` (`buildMeLive`).
 */
export async function buildMeBootstrapStable(
  user: MeBootstrapUser,
): Promise<MeBootstrapStablePayload> {
  const failed: BootstrapBlockName[] = [];
  const stable = await loadStableParts(user, failed);
  return {
    version: 2,
    user: bootstrapUser(user),
    ...stable,
    failedBlocks: failed.sort(),
  };
}

/**
 * Payload VOLÁTIL (`GET /api/me/live`): os campos que saíram do bootstrap
 * v2, com o MESMO formato que tinham no v1.
 */
export async function buildMeLive(
  user: MeBootstrapUser,
  hooks: BuildMeBootstrapHooks = {},
): Promise<MeLivePayload> {
  const failed: BootstrapBlockName[] = [];
  const live = await loadLiveParts(user, failed, hooks);
  return { version: 1, ...live, failedBlocks: failed.sort() };
}

function bootstrapUser(user: MeBootstrapUser): MeBootstrapPayload["user"] {
  return {
    id: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  };
}

type StableParts = Pick<
  MeBootstrapPayload,
  | "profile"
  | "preferences"
  | "effectivePermissions"
  | "organization"
  | "alertConfig"
  | "widgets"
>;

type LiveParts = Pick<MeBootstrapPayload, "agentStatus" | "emailUnread" | "teamChatRooms">;

async function loadStableParts(
  user: MeBootstrapUser,
  failed: BootstrapBlockName[],
): Promise<StableParts> {
  // Slugs ativos alimentam dois blocos (widgets e availableKeys das
  // preferências) — uma consulta só. Sem org (super-admin puro) não há
  // widgets instalados.
  const activeSlugsPromise: Promise<Set<string> | null> = user.organizationId
    ? settle("widgets", failed, () => getActiveWidgetSlugs())
    : Promise.resolve(new Set<string>());

  const [profile, activeSlugs, effectivePermissions, organization, alertConfig] =
    await Promise.all([
      settle("profile", failed, () => loadProfile(user.id)),
      activeSlugsPromise,
      settle("effectivePermissions", failed, () => loadEffectivePermissions(user)),
      settle("organization", failed, () => loadOrganization(user.organizationId)),
      settle("alertConfig", failed, () => loadAlertConfig(user)),
    ]);

  const preferences = await settle("preferences", failed, () =>
    loadPreferences(user, activeSlugs ?? new Set<string>()),
  );

  return {
    profile,
    preferences,
    effectivePermissions,
    organization,
    alertConfig,
    widgets: activeSlugs === null ? null : { activeSlugs: [...activeSlugs].sort() },
  };
}

async function loadLiveParts(
  user: MeBootstrapUser,
  failed: BootstrapBlockName[],
  hooks: BuildMeBootstrapHooks,
): Promise<LiveParts> {
  const [agentStatus, emailUnread, teamChatRooms] = await Promise.all([
    settle("agentStatus", failed, () => loadAgentStatus(user.id)),
    settle("emailUnread", failed, () => loadEmailUnread(user)),
    settle("teamChatRooms", failed, () => loadTeamChatRooms(user, hooks.onTeamChatRooms)),
  ]);
  return { agentStatus, emailUnread, teamChatRooms };
}

// ──────────────────────────────────────────────
// ETag
// ──────────────────────────────────────────────

/** ETag forte: sha1 do corpo JSON serializado (sem timestamps no payload). */
export function computeBootstrapEtag(body: string): string {
  return `"${createHash("sha1").update(body).digest("hex")}"`;
}

/**
 * ETag do bootstrap com blocos: usuário + payload base + (url, ETag) de cada
 * bloco, na ordem do contrato. Com os ETags dos blocos já guardados, dá para
 * responder 304 sem ler nenhum corpo de bloco. Fraco (`W/`): o proxy pode
 * comprimir a resposta.
 */
export function computeBootstrapBlocksEtag(
  userId: string,
  baseJson: string,
  blocks: readonly { url: string; etag: string }[],
  blockErrors: readonly string[] = [],
): string {
  const h = createHash("sha1").update(userId).update("\n").update(baseJson);
  for (const b of blocks) h.update("\n").update(b.url).update("=").update(b.etag);
  if (blockErrors.length > 0) h.update("\nerr=").update(blockErrors.join(","));
  return `W/"${h.digest("hex").slice(0, 32)}"`;
}

/**
 * `If-None-Match` pode trazer vários valores separados por vírgula e o
 * prefixo fraco `W/`. Compara ignorando o `W/` (semântica fraca basta
 * para poupar o corpo).
 */
export function etagMatches(
  ifNoneMatch: string | null | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  const strip = (v: string) => v.trim().replace(/^W\//i, "");
  const wanted = strip(etag);
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map(strip)
    .some((v) => v === wanted);
}
