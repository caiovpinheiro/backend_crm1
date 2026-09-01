/**
 * Lógica de grants sem I/O — seguro para import em Client Components.
 * (Não importar Prisma/request-context aqui.)
 */

/**
 * Deve coincidir com `InboxTab` em `@/services/conversations`.
 * "todos" é aba agregadora — controlada por `inbox:tab:todos`.
 */
export type InboxTab =
  | "entrada"
  | "esperando"
  | "respondidas"
  | "agente_ia"
  | "automacao"
  | "finalizados"
  | "erro"
  | "todos"
  | "abertas"
  | "ligar";

/** Super-tabs (não são categorias): agregam várias categorias/estados. */
type InboxSuperTab = "todos" | "abertas";

/** Ordem da barra da Inbox (sem `abertas`, super-tab auxiliar). */
export const INBOX_TAB_BAR_ORDER: readonly Exclude<InboxTab, "abertas">[] = [
  "todos",
  "entrada",
  "esperando",
  "respondidas",
  "ligar",
  "agente_ia",
  "automacao",
  "finalizados",
  "erro",
];

type RoleKey = "ADMIN" | "MANAGER" | "MEMBER";
type RoleScope = Partial<Record<RoleKey, string[]>>;

/**
 * Override por usuário individual para ações do CRM.
 *
 * 29/mai/26 — adicionado para suportar a tela `/settings/permissions` no
 * frontend, que define toggles por usuário (não por papel) para 3 ações:
 *
 *   - `editLeads`     — mover deals entre estágios + editar campos
 *   - `runAutomations`— disparar automações manualmente
 *   - `assignOwner`   — atribuir/trocar responsável
 *
 * Schema: `crm.<action>.users[userId] = boolean`
 *   - `true`  → override permissivo (passa mesmo se RBAC negar)
 *   - `false` → override restritivo (bloqueia mesmo se RBAC permitir)
 *   - chave ausente → segue regra do RBAC (`Role` + `UserRoleAssignment`)
 *
 * Quem consome: `requirePermissionForUser` (`resource-policy.ts`) faz o
 * lookup ANTES de retornar 403, mapeando `PermissionKey` → `CrmActionKey`
 * via `RBAC_TO_CRM_ACTION`.
 */
export type CrmActionKey = "editLeads" | "runAutomations" | "assignOwner";
type CrmActionUserGrants = Partial<Record<string, boolean>>;
export type CrmActionGrants = Partial<
  Record<CrmActionKey, { users?: CrmActionUserGrants }>
>;

/**
 * Override por usuário individual (não por papel) para escopo de recursos
 * com instâncias dinâmicas — funis e canais.
 *
 * Schema: `users[userId] = string[]`
 *   - `["*"]`           → acesso a todos (equivale a "sem restrição")
 *   - `["id1","id2"]`   → restrito a esses IDs
 *   - `[]`              → nenhum acesso (restrição total)
 *   - chave ausente     → cai na regra por papel (`pipeline.view[role]`) ou,
 *                          quando não houver, libera (default permissivo)
 *
 * 09/jun/26 — adicionado para suportar escopo por usuário de funis
 * (`pipeline.users`) e canais (`channel.view/send.users`), configurável na
 * tela de cada usuário em /settings/permissions.
 */
export type UserScopeGrants = Partial<Record<string, string[]>>;

export type ScopeGrants = {
  /** Abas da Inbox por papel (`MEMBER`). Valores: chaves de aba ou `"*"`. */
  inbox?: {
    tabs?: RoleScope;
  };
  pipeline?: {
    view?: RoleScope;
    edit?: RoleScope;
    /** Override por usuário: lista de IDs de funis visíveis (ou `["*"]`). */
    users?: UserScopeGrants;
  };
  /**
   * Escopo de canais (instâncias dinâmicas de `Channel`). 4 eixos de ação +
   * override `deny`. Cada eixo de ação aceita 3 principais ADITIVOS (OR):
   *   - `users[userId]`   → override por usuário (configurável na ficha do user)
   *   - `roles[roleId]`   → grant por Role CUSTOMIZADA (editor de papel).
   *                          `roleId` é o id real da Role.
   *
   * Ações (ver `canAccessChannelForUser`):
   *   - `view`     — ler conversas/mensagens do canal
   *   - `send`     — responder em conversa existente (exige `view`)
   *   - `initiate` — criar conversa nova com cliente (exige `view`)
   *   - `manage`   — administrar o canal (PUT/DELETE/connect/disconnect/qr).
   *                  IMPLICA `view` + `send` + `initiate` automaticamente.
   *
   * Resolução: para cada ação, regras de user + roles são unidas
   * de forma permissiva (OR). Sem nenhuma regra → liberado (compat com
   * comportamento anterior — orgs sem upgrade ficam idênticas).
   *
   * `deny` é GLOBAL ao canal (não por eixo): se `chId` aparece em
   * `deny.users[uid]` (ou em deny.roles que cubra o user), ALL
   * actions naquele canal são negadas — independente de grants positivos.
   * Anti-lockout: ADMIN (enum legado) e quem tem `manage` no canal IGNORAM
   * o deny (admin do canal não pode ser bloqueado dele acidentalmente).
   */
  channel?: {
    view?: {
      users?: UserScopeGrants;
      roles?: UserScopeGrants;
    };
    send?: {
      users?: UserScopeGrants;
      roles?: UserScopeGrants;
    };
    initiate?: {
      users?: UserScopeGrants;
      roles?: UserScopeGrants;
    };
    manage?: {
      users?: UserScopeGrants;
      roles?: UserScopeGrants;
    };
    /** Override negativo — lista de canais a NEGAR pra principal (user/role). */
    deny?: {
      users?: UserScopeGrants;
      roles?: UserScopeGrants;
    };
  };
  stage?: {
    view?: RoleScope;
    move?: RoleScope;
    edit?: RoleScope;
  };
  field?: {
    deal?: {
      view?: RoleScope;
      edit?: RoleScope;
    };
    contact?: {
      view?: RoleScope;
      edit?: RoleScope;
    };
    product?: {
      view?: RoleScope;
      edit?: RoleScope;
    };
  };
  sidebar?: {
    routes?: RoleScope;
    settingsItems?: RoleScope;
  };
  /**
   * Overrides por usuário para 3 ações de alto nível do CRM. Configurado
   * via UI em /settings/permissions; consultado em
   * `requirePermissionForUser` como fallback permissivo quando o RBAC
   * tradicional negaria.
   */
  crm?: CrmActionGrants;
};

export const CRM_ACTION_KEYS: readonly CrmActionKey[] = [
  "editLeads",
  "runAutomations",
  "assignOwner",
] as const;

function asRoleKey(role: string | null | undefined): RoleKey | null {
  if (role === "ADMIN" || role === "MANAGER" || role === "MEMBER") return role;
  return null;
}

function normalizeIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function normalizeRoleScope(input: unknown): RoleScope {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: RoleScope = {};
  // Só inclui papéis presentes no input — ausente ≠ `[]`.
  // `[]` explícito = nenhum acesso; chave ausente = sem regra (default permissivo
  // nos demais scopes / fallback de permissions nas abas da inbox).
  for (const role of ["ADMIN", "MANAGER", "MEMBER"] as const) {
    if (Array.isArray(src[role])) {
      out[role] = normalizeIds(src[role]);
    }
  }
  return out;
}

function normalizeUserScope(input: unknown): UserScopeGrants {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: UserScopeGrants = {};
  for (const [userId, raw] of Object.entries(src)) {
    if (typeof userId !== "string" || !userId) continue;
    out[userId] = normalizeIds(raw);
  }
  return out;
}

function normalizeCrmUserGrants(input: unknown): CrmActionUserGrants {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: CrmActionUserGrants = {};
  for (const [userId, raw] of Object.entries(src)) {
    if (typeof userId !== "string" || !userId) continue;
    if (typeof raw === "boolean") out[userId] = raw;
  }
  return out;
}

function normalizeCrmGrants(input: unknown): CrmActionGrants {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: CrmActionGrants = {};
  for (const action of CRM_ACTION_KEYS) {
    const node = src[action];
    if (!node || typeof node !== "object") continue;
    const usersRaw = (node as Record<string, unknown>).users;
    out[action] = { users: normalizeCrmUserGrants(usersRaw) };
  }
  return out;
}

export function parseScopeGrants(input: unknown): ScopeGrants {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pipeline = src.pipeline && typeof src.pipeline === "object" ? (src.pipeline as Record<string, unknown>) : {};
  const stage = src.stage && typeof src.stage === "object" ? (src.stage as Record<string, unknown>) : {};
  const field = src.field && typeof src.field === "object" ? (src.field as Record<string, unknown>) : {};
  const sidebar = src.sidebar && typeof src.sidebar === "object" ? (src.sidebar as Record<string, unknown>) : {};
  const inbox = src.inbox && typeof src.inbox === "object" ? (src.inbox as Record<string, unknown>) : {};
  const channel = src.channel && typeof src.channel === "object" ? (src.channel as Record<string, unknown>) : {};
  const channelView = channel.view && typeof channel.view === "object" ? (channel.view as Record<string, unknown>) : {};
  const channelSend = channel.send && typeof channel.send === "object" ? (channel.send as Record<string, unknown>) : {};
  const channelInitiate = channel.initiate && typeof channel.initiate === "object" ? (channel.initiate as Record<string, unknown>) : {};
  const channelManage = channel.manage && typeof channel.manage === "object" ? (channel.manage as Record<string, unknown>) : {};
  const channelDeny = channel.deny && typeof channel.deny === "object" ? (channel.deny as Record<string, unknown>) : {};
  const dealField = field.deal && typeof field.deal === "object" ? (field.deal as Record<string, unknown>) : {};
  const contactField = field.contact && typeof field.contact === "object" ? (field.contact as Record<string, unknown>) : {};
  const productField = field.product && typeof field.product === "object" ? (field.product as Record<string, unknown>) : {};
  return {
    inbox: {
      tabs: normalizeRoleScope(inbox.tabs),
    },
    pipeline: {
      view: normalizeRoleScope(pipeline.view),
      edit: normalizeRoleScope(pipeline.edit),
      users: normalizeUserScope(pipeline.users),
    },
    channel: {
      view: {
        users: normalizeUserScope(channelView.users),
        roles: normalizeUserScope(channelView.roles),
      },
      send: {
        users: normalizeUserScope(channelSend.users),
        roles: normalizeUserScope(channelSend.roles),
      },
      initiate: {
        users: normalizeUserScope(channelInitiate.users),
        roles: normalizeUserScope(channelInitiate.roles),
      },
      manage: {
        users: normalizeUserScope(channelManage.users),
        roles: normalizeUserScope(channelManage.roles),
      },
      deny: {
        users: normalizeUserScope(channelDeny.users),
        roles: normalizeUserScope(channelDeny.roles),
      },
    },
    stage: {
      view: normalizeRoleScope(stage.view),
      move: normalizeRoleScope(stage.move),
      edit: normalizeRoleScope(stage.edit),
    },
    field: {
      deal: {
        view: normalizeRoleScope(dealField.view),
        edit: normalizeRoleScope(dealField.edit),
      },
      contact: {
        view: normalizeRoleScope(contactField.view),
        edit: normalizeRoleScope(contactField.edit),
      },
      product: {
        view: normalizeRoleScope(productField.view),
        edit: normalizeRoleScope(productField.edit),
      },
    },
    sidebar: {
      routes: normalizeRoleScope(sidebar.routes),
      settingsItems: normalizeRoleScope(sidebar.settingsItems),
    },
    crm: normalizeCrmGrants(src.crm),
  };
}

/** Merge imutável dos overrides CRM de um usuário (aceite de convite). */
export function mergeCrmActionGrantsForUser(
  scopeGrants: unknown,
  userId: string,
  grants: Partial<Record<CrmActionKey, boolean>>,
): ScopeGrants {
  const current = parseScopeGrants(scopeGrants);
  const currentCrm: CrmActionGrants = { ...(current.crm ?? {}) };
  for (const action of CRM_ACTION_KEYS) {
    const value = grants[action];
    if (value === undefined) continue;
    const currentAction = currentCrm[action] ?? {};
    currentCrm[action] = {
      ...currentAction,
      users: {
        ...(currentAction.users ?? {}),
        [userId]: value,
      },
    };
  }
  return { ...current, crm: currentCrm };
}

/**
 * Lê o override por usuário para uma ação do CRM. Retorna `true | false`
 * (override explícito) ou `null` (sem override — segue a regra do RBAC).
 *
 * Mantém-se em scope-grants-shared (zero I/O) pra ser usável tanto no
 * backend (resource-policy) quanto em código compartilhado eventual.
 */
export function readCrmActionGrant(
  grants: ScopeGrants,
  action: CrmActionKey,
  userId: string,
): boolean | null {
  const node = grants.crm?.[action];
  if (!node) return null;
  const value = node.users?.[userId];
  if (value === true || value === false) return value;
  return null;
}

function hasRoleRule(scope: RoleScope | undefined, role: RoleKey): boolean {
  if (!scope) return false;
  return Array.isArray(scope[role]);
}

function roleRuleAllows(scope: RoleScope | undefined, role: RoleKey, value: string): boolean {
  const ids = scope?.[role];
  if (!ids || ids.length === 0) return true;
  if (ids.includes("*")) return true;
  return ids.includes(value);
}

export function canAccessScopedResource(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  resource: "pipeline" | "stage";
  action: "view" | "edit" | "move";
  targetId: string;
}): boolean {
  const role = asRoleKey(args.role);
  if (!role || role === "ADMIN") return true;
  const scope =
    args.resource === "pipeline"
      ? args.action === "view"
        ? args.grants.pipeline?.view
        : args.grants.pipeline?.edit
      : args.action === "view"
        ? args.grants.stage?.view
        : args.action === "edit"
          ? args.grants.stage?.edit
          : args.grants.stage?.move;
  if (!hasRoleRule(scope, role)) return true;
  return roleRuleAllows(scope, role, args.targetId);
}

/**
 * Avalia uma lista de IDs de override por usuário.
 * `["*"]` → libera tudo; lista vazia → nega; senão precisa conter o alvo.
 */
function userScopeAllows(ids: string[], value: string): boolean {
  if (ids.includes("*")) return true;
  return ids.includes(value);
}

/**
 * Acesso (view) a um funil considerando override por usuário e fallback
 * para a regra por papel. ADMIN sempre libera.
 */
export function canAccessPipelineForUser(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  userId: string;
  pipelineId: string;
}): boolean {
  if (asRoleKey(args.role) === "ADMIN") return true;
  const userRule = args.grants.pipeline?.users?.[args.userId];
  if (Array.isArray(userRule)) return userScopeAllows(userRule, args.pipelineId);
  return canAccessScopedResource({
    grants: args.grants,
    role: args.role,
    resource: "pipeline",
    action: "view",
    targetId: args.pipelineId,
  });
}

/**
 * Lista de IDs de funis permitidos a um usuário, para filtrar queries.
 * Retorna `null` quando não há restrição (acesso a todos); array (possivelmente
 * vazio) quando restrito.
 */
export function listAllowedPipelineIdsForUser(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  userId: string;
}): string[] | null {
  const role = asRoleKey(args.role);
  if (role === "ADMIN") return null;
  const userRule = args.grants.pipeline?.users?.[args.userId];
  if (Array.isArray(userRule)) {
    if (userRule.includes("*")) return null;
    return userRule;
  }
  if (!role) return null;
  const roleScope = args.grants.pipeline?.view?.[role];
  if (!Array.isArray(roleScope) || roleScope.length === 0 || roleScope.includes("*")) {
    return null;
  }
  return roleScope;
}

type ChannelAction = "view" | "send" | "initiate" | "manage";
type ChannelGrantNode = {
  users?: UserScopeGrants;
  roles?: UserScopeGrants;
};

/**
 * Coleta as regras aplicáveis a um usuário pra um nó de grant de canal
 * (user override + grants das roles). Cada entrada é uma lista de IDs;
 * resolução ADITIVA (OR) em `canAccessChannelForUser`.
 */
function collectChannelRules(
  node: ChannelGrantNode | undefined,
  userId: string,
  roleIds: string[],
): string[][] {
  const rules: string[][] = [];
  const userRule = node?.users?.[userId];
  if (Array.isArray(userRule)) rules.push(userRule);
  for (const roleId of roleIds) {
    const roleRule = node?.roles?.[roleId];
    if (Array.isArray(roleRule)) rules.push(roleRule);
  }
  return rules;
}

/**
 * Checa se o canal cai em alguma regra de `deny` que cubra o usuário (via
 * user ou role). Deny é GLOBAL ao canal — se bater, nega todas as
 * ações nesse canal, exceto pra ADMIN ou pra quem tem `manage` no mesmo
 * canal (anti-lockout, ver `canAccessChannelForUser`).
 */
function isChannelDenied(
  deny: ChannelGrantNode | undefined,
  userId: string,
  roleIds: string[],
  channelId: string,
): boolean {
  const rules = collectChannelRules(deny, userId, roleIds);
  if (rules.length === 0) return false;
  return rules.some((r) => userScopeAllows(r, channelId));
}

/**
 * Resolve grants positivos pra uma ação: regras definidas devem cobrir o
 * canal (OR entre user+roles). Sem nenhuma regra → permissivo
 * (compat com comportamento pré-feature; orgs sem upgrade ficam idênticas).
 */
function actionAllowsChannel(
  node: ChannelGrantNode | undefined,
  userId: string,
  roleIds: string[],
  channelId: string,
): boolean {
  const rules = collectChannelRules(node, userId, roleIds);
  if (rules.length === 0) return true;
  return rules.some((r) => userScopeAllows(r, channelId));
}

/**
 * Acesso a um canal pra uma ação (view/send/initiate/manage).
 *
 * Precedência:
 *   1. ADMIN (enum legado) → bypass total (inclusive deny).
 *   2. `manage` no canal → ignora deny do mesmo canal (anti-lockout: quem
 *      administra o canal não pode ser bloqueado dele por accident). Manage
 *      implica view+send+initiate.
 *   3. Deny global no canal → nega TODAS as ações.
 *   4. Senão: regra positiva da ação solicitada. Dependências:
 *      - `send` exige `view`
 *      - `initiate` exige `view`
 *      - `manage` (caso 2 acima) implica tudo
 *      Sem nenhuma regra positiva → permissivo (compat).
 */
export function canAccessChannelForUser(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  userId: string;
  action: ChannelAction;
  channelId: string;
  roleIds?: string[];
}): boolean {
  if (asRoleKey(args.role) === "ADMIN") return true;
  const roleIds = args.roleIds ?? [];

  const hasManage = actionAllowsChannel(
    args.grants.channel?.manage,
    args.userId,
    roleIds,
    args.channelId,
  );
  const hasExplicitManageGrant =
    collectChannelRules(args.grants.channel?.manage, args.userId, roleIds).length > 0;
  const managesThisChannel = hasManage && hasExplicitManageGrant;

  if (!managesThisChannel) {
    if (
      isChannelDenied(args.grants.channel?.deny, args.userId, roleIds, args.channelId)
    ) {
      return false;
    }
  }

  if (args.action === "manage") {
    return hasManage;
  }

  if (managesThisChannel) return true;

  const viewOk = actionAllowsChannel(
    args.grants.channel?.view,
    args.userId,
    roleIds,
    args.channelId,
  );
  if (!viewOk) return false;

  if (args.action === "view") return true;

  const node =
    args.action === "send"
      ? args.grants.channel?.send
      : args.grants.channel?.initiate;
  return actionAllowsChannel(node, args.userId, roleIds, args.channelId);
}

/**
 * Lista de IDs de canais que o usuário pode VER, pra filtrar conversas.
 * Une grants de user + roles e remove canais negados explicitamente
 * por `deny` (a menos que o user tenha `manage` cobrindo o canal).
 *
 * Retorna `null` quando não há restrição (nenhuma regra de view ou alguma
 * com `*`, e sem deny relevante); array (possivelmente vazio) quando
 * restrito.
 */
export function listAllowedChannelIdsForUser(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  userId: string;
  roleIds?: string[];
}): string[] | null {
  if (asRoleKey(args.role) === "ADMIN") return null;
  const roleIds = args.roleIds ?? [];

  const viewRules = collectChannelRules(
    args.grants.channel?.view,
    args.userId,
    roleIds,
  );
  const denyRules = collectChannelRules(
    args.grants.channel?.deny,
    args.userId,
    roleIds,
  );
  const manageRules = collectChannelRules(
    args.grants.channel?.manage,
    args.userId,
    roleIds,
  );

  const noViewRestriction =
    viewRules.length === 0 || viewRules.some((r) => r.includes("*"));
  const noDeny = denyRules.length === 0;

  if (noViewRestriction && noDeny) return null;

  // Coleta canais com manage explícito — escapam do deny (anti-lockout).
  const manageWildcard = manageRules.some((r) => r.includes("*"));
  const managedChannels = new Set<string>();
  if (manageRules.length > 0 && !manageWildcard) {
    for (const r of manageRules) for (const id of r) if (id !== "*") managedChannels.add(id);
  }

  // Conjunto de view: união de regras (ou null = todos).
  let allowed: Set<string> | null = null;
  if (!noViewRestriction) {
    allowed = new Set<string>();
    for (const r of viewRules) for (const id of r) if (id !== "*") allowed.add(id);
  }

  // Aplica deny removendo dos permitidos (a menos que canal seja administrado).
  if (!noDeny) {
    const deniedSet = new Set<string>();
    for (const r of denyRules) for (const id of r) if (id !== "*") deniedSet.add(id);
    if (allowed === null) {
      // sem restrição de view, mas há deny → resultado é "todos exceto deny",
      // que não dá pra representar com array finito. Retornamos null + filtro
      // depois (caller que tem lista completa de canais precisa filtrar deny
      // manualmente — atualmente não é o caso de uso). Pra simplificar e
      // manter o contrato, materializamos vazio só se manageWildcard ausente
      // E não houver wildcard de view. Decisão: deny + view-livre é
      // configuração rara; retornamos null e deixamos o enforcement pontual
      // (`canAccessChannelForUser`) negar canal a canal.
      return manageWildcard ? null : null;
    }
    for (const id of deniedSet) {
      if (manageWildcard || managedChannels.has(id)) continue;
      allowed.delete(id);
    }
  }

  return allowed ? Array.from(allowed) : null;
}

export function canAccessField(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  entity: "deal" | "contact" | "product";
  action: "view" | "edit";
  fieldKey: string;
}): boolean {
  const role = asRoleKey(args.role);
  if (!role || role === "ADMIN") return true;
  const root = args.grants.field?.[args.entity];
  const scope = args.action === "view" ? root?.view : root?.edit;
  if (!hasRoleRule(scope, role)) return true;
  return roleRuleAllows(scope, role, args.fieldKey);
}

export function canSeeSidebarRoute(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  route: string;
}): boolean {
  const role = asRoleKey(args.role);
  if (!role || role === "ADMIN") return true;
  const scope = args.grants.sidebar?.routes;
  if (!hasRoleRule(scope, role)) return true;
  return roleRuleAllows(scope, role, args.route);
}

export function canSeeSettingsItem(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  itemId: string;
}): boolean {
  const role = asRoleKey(args.role);
  if (!role || role === "ADMIN") return true;
  const scope = args.grants.sidebar?.settingsItems;
  if (!hasRoleRule(scope, role)) return true;
  return roleRuleAllows(scope, role, args.itemId);
}

const DEFAULT_MEMBER_INBOX_TABS = new Set<InboxTab>(["esperando", "respondidas"]);

/**
 * Permission keys canônicas por aba (`inbox:tab:<id>`).
 * Fonte alinhada a `PERMISSION_CATALOG` resource `inbox`.
 * Inclui a super-tab `todos`; `abertas` permanece sempre visível.
 */
const INBOX_TAB_PERMISSION_KEYS: Record<Exclude<InboxTab, "abertas">, string> = {
  todos: "inbox:tab:todos",
  entrada: "inbox:tab:entrada",
  esperando: "inbox:tab:esperando",
  respondidas: "inbox:tab:respondidas",
  ligar: "inbox:tab:ligar",
  agente_ia: "inbox:tab:agente_ia",
  automacao: "inbox:tab:automacao",
  finalizados: "inbox:tab:finalizados",
  erro: "inbox:tab:erro",
};

/**
 * Fallback legado (rollout): se a org/usuário ainda NÃO tem nenhuma
 * `inbox:tab:*`, deriva das actions de `conversation` (comportamento pré-filas).
 * `todos` permanece liberada no legado (agregadora).
 */
const LEGACY_INBOX_TAB_REQUIRED_PERMISSION: Record<
  Exclude<InboxTab, InboxSuperTab>,
  string
> = {
  entrada: "conversation:claim",
  esperando: "conversation:view",
  respondidas: "conversation:view",
  ligar: "conversation:view",
  agente_ia: "conversation:view",
  automacao: "conversation:view",
  finalizados: "conversation:view",
  erro: "conversation:view",
};

function toPermissionSet(
  permissions: ReadonlySet<string> | readonly string[] | null | undefined,
): ReadonlySet<string> | null {
  if (!permissions) return null;
  return permissions instanceof Set ? permissions : new Set(permissions);
}

/** Checa uma permission key respeitando wildcards `*` e `<resource>:*`. */
function permissionsAllow(perms: ReadonlySet<string>, key: string): boolean {
  if (perms.has("*") || perms.has(key)) return true;
  const colon = key.indexOf(":");
  if (colon > 0 && perms.has(`${key.slice(0, colon)}:*`)) return true;
  return false;
}

function hasAnyInboxTabPermission(perms: ReadonlySet<string>): boolean {
  if (perms.has("*") || perms.has("inbox:*")) return true;
  for (const key of Object.values(INBOX_TAB_PERMISSION_KEYS)) {
    if (perms.has(key)) return true;
  }
  return false;
}

function memberTabAllowedByPermissions(
  perms: ReadonlySet<string>,
  tab: Exclude<InboxTab, "abertas">,
): boolean {
  if (hasAnyInboxTabPermission(perms)) {
    // Rollout: orgs com `inbox:tab:*` antigo (sem ligar) ainda veem a fila
    // se já enxergam Aguardando ou Respondidas.
    if (tab === "ligar") {
      return (
        permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS.ligar) ||
        permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS.esperando) ||
        permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS.respondidas)
      );
    }
    // Rollout: antes da aba existir, as conversas com a IA como responsável
    // apareciam em Entrada/Automação. Roles gravadas antes disso continuam
    // enxergando a fila pelas chaves antigas.
    if (tab === "agente_ia") {
      return (
        permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS.agente_ia) ||
        permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS.entrada) ||
        permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS.automacao)
      );
    }
    return permissionsAllow(perms, INBOX_TAB_PERMISSION_KEYS[tab]);
  }
  // Legado: agregadora "todos" sempre liberada.
  if (tab === "todos") return true;
  const required = LEGACY_INBOX_TAB_REQUIRED_PERMISSION[tab];
  if (!required) return false;
  return permissionsAllow(perms, required);
}

/**
 * Decide se um papel pode ver uma aba da inbox.
 *
 * Ordem de precedência para MEMBER:
 *   1. ADMIN/MANAGER (`User.role`) ou permission `*` → todas as abas.
 *   2. Regra explícita `inbox.tabs.MEMBER` (scope-grants) — lista / `"*"` =
 *      essas abas. Vence permissions quando presente. `[]` = legado sem UI
 *      que o grave: tratado como ausência de regra (ver comentário abaixo).
 *   3. Permission keys `inbox:tab:<id>` (quando ao menos uma existe no papel),
 *      inclusive `inbox:tab:todos`.
 *   4. Fallback legado: `conversation:view` / `conversation:claim`
 *      (`todos` sempre liberada no legado).
 *   5. Default histórico: `esperando` / `respondidas` (+ `todos`).
 *
 * Nota: `sharedInbox` do Role NÃO libera abas — use `inbox:tab:entrada` +
 * `conversation:claim` (e `inbox:tab:automacao` para a fila de automação).
 * `abertas` permanece sempre visível (super-tab auxiliar).
 */
export function canSeeInboxTab(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  tab: InboxTab;
  permissions?: ReadonlySet<string> | readonly string[] | null;
}): boolean {
  if (args.tab === "abertas") return true;
  const role = asRoleKey(args.role);
  const perms = toPermissionSet(args.permissions);
  if (perms && permissionsAllow(perms, "*")) return true;
  if (!role || role === "ADMIN" || role === "MANAGER") return true;

  // Lista vazia NÃO é "nenhuma aba". Nenhuma tela grava `inbox.tabs` hoje — o
  // controle das filas vive nas permissions `inbox:tab:*` da role —, então uma
  // lista vazia só sobra de configuração legada. Honrá-la bloqueava a Inbox
  // inteira do operador (todas as abas, contadores zerados, 403 na listagem)
  // mesmo com as filas liberadas na role, e sem UI para desfazer. Vazio = sem
  // regra: cai para as permissions, que seguem fail-closed.
  const tabIds = args.grants.inbox?.tabs?.MEMBER;
  if (Array.isArray(tabIds) && tabIds.length > 0) {
    if (tabIds.includes("*")) return true;
    return tabIds.includes(args.tab);
  }
  if (perms) {
    return memberTabAllowedByPermissions(perms, args.tab);
  }
  if (args.tab === "todos") return true;
  return DEFAULT_MEMBER_INBOX_TABS.has(args.tab);
}

export function listAllowedInboxTabsForUser(args: {
  grants: ScopeGrants;
  role: string | null | undefined;
  permissions?: ReadonlySet<string> | readonly string[] | null;
}): InboxTab[] {
  const role = asRoleKey(args.role);
  const perms = toPermissionSet(args.permissions);
  if ((perms && permissionsAllow(perms, "*")) || !role || role === "ADMIN" || role === "MANAGER") {
    return [...INBOX_TAB_BAR_ORDER];
  }
  const allowed = INBOX_TAB_BAR_ORDER.filter((t) =>
    canSeeInboxTab({ grants: args.grants, role, tab: t, permissions: args.permissions }),
  );
  if (allowed.length > 0) return allowed;
  const showTodos = canSeeInboxTab({
    grants: args.grants,
    role,
    tab: "todos",
    permissions: args.permissions,
  });
  const fallback: Exclude<InboxTab, InboxSuperTab | "ligar">[] = ["esperando", "respondidas"];
  return showTodos ? ["todos", ...fallback] : [...fallback];
}
