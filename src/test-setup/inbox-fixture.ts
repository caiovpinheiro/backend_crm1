/**
 * Org de mentira para os testes do inbox (contagem de consultas e
 * autorização de conversa): 4 usuários, 3 contatos, conversas atribuídas a
 * agentes diferentes, uma na fila e um ticket antigo encerrado.
 */
import { FakeDb, INBOX_SCHEMA } from "@/test-setup/fake-db";

export const ORG = "org_1";
export const OTHER_ORG = "org_2";

export const USERS = {
  member: { id: "u_member", name: "Ana Lima", email: "ana@example.test", role: "MEMBER" },
  other: { id: "u_other", name: "Bruno Reis", email: "bruno@example.test", role: "MEMBER" },
  manager: { id: "u_manager", name: "Carla Dias", email: "carla@example.test", role: "MANAGER" },
  admin: { id: "u_admin", name: "Davi Nunes", email: "davi@example.test", role: "ADMIN" },
} as const;

export type FixtureUserKey = keyof typeof USERS;

export const CONV = {
  /** Atribuída a `member`, com mensagens, fixado, favorito e ticket antigo. */
  mine: "conv_mine",
  /** Atribuída a `other` (outro contato). */
  others: "conv_others",
  /** Sem responsável, OPEN (fila de entrada). */
  queue: "conv_queue",
  /** Ticket RESOLVED anterior do mesmo contato/canal de `mine`. */
  resolved: "conv_resolved",
  /** Atribuída a `other`, mas o negócio do contato é de `member`. */
  dealOwner: "conv_deal_owner",
  /** Mesma forma de `mine`, em outra organização. */
  foreign: "conv_foreign",
} as const;

/**
 * Modelos do fixture que a extension de tenant de `@/lib/prisma` escopa por
 * organização (subconjunto de `SCOPED_MODELS`, em camelCase).
 */
export const SCOPED_FIXTURE_MODELS: ReadonlySet<string> = new Set([
  "conversation",
  "message",
  "contact",
  "deal",
  "channel",
  "agentPermission",
  "favoriteMessage",
  "organizationSetting",
  "userRoleAssignment",
  "role",
  "activityEvent",
]);

export const SCOPE_GRANTS_KEY = "permissions.scope.grants.v1";
export const RBAC_FLAG = "rbac_granular_scope_v1";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

export type SeedOptions = {
  /** Liga `rbac_granular_scope_v1` na org. */
  rbacFlag?: boolean;
  /** JSON de `permissions.scope.grants.v1`. */
  scopeGrants?: unknown;
  /** Permissões do papel do operador (MEMBER). */
  memberPermissions?: string[];
  /** `AgentPermission.allowedDepartmentIds` por usuário. */
  departments?: Partial<Record<FixtureUserKey, string[]>>;
  /** `visibility.MANAGER` / `visibility.MEMBER` / `unassigned.*`. */
  settings?: Record<string, string>;
  /** Ajuste livre depois do seed (papéis, grants de funil, departamentos…). */
  mutate?: (db: FakeDb) => void;
};

export function seedInbox(opts: SeedOptions = {}): FakeDb {
  const db = new FakeDb(INBOX_SCHEMA);

  for (const u of Object.values(USERS)) {
    db.insert("user", {
      ...u,
      organizationId: ORG,
      type: "HUMAN",
      avatarUrl: `https://cdn.example.test/${u.id}.png`,
    });
  }

  db.insert(
    "role",
    {
      id: "role_member",
      organizationId: ORG,
      systemPreset: "MEMBER",
      permissions: opts.memberPermissions ?? ["conversation:view", "conversation:reply"],
      sharedInbox: true,
      mediaAccess: true,
      seeTeam: false,
      seeUnassigned: false,
    },
    {
      id: "role_manager",
      organizationId: ORG,
      systemPreset: "MANAGER",
      permissions: ["conversation:view", "conversation:reply", "conversation:claim"],
      sharedInbox: true,
      mediaAccess: true,
      seeTeam: false,
      seeUnassigned: false,
    },
    {
      id: "role_admin",
      organizationId: ORG,
      systemPreset: "ADMIN",
      permissions: ["*"],
      sharedInbox: true,
      mediaAccess: true,
      seeTeam: false,
      seeUnassigned: false,
    },
  );
  db.insert(
    "userRoleAssignment",
    { userId: USERS.member.id, organizationId: ORG, roleId: "role_member" },
    { userId: USERS.other.id, organizationId: ORG, roleId: "role_member" },
    { userId: USERS.manager.id, organizationId: ORG, roleId: "role_manager" },
    { userId: USERS.admin.id, organizationId: ORG, roleId: "role_admin" },
  );

  for (const [key, ids] of Object.entries(opts.departments ?? {})) {
    db.insert("agentPermission", {
      userId: USERS[key as FixtureUserKey].id,
      organizationId: ORG,
      allowedDepartmentIds: ids,
    });
  }

  if (opts.rbacFlag !== undefined) {
    db.insert("organizationFeatureFlag", {
      organizationId: ORG,
      key: RBAC_FLAG,
      enabled: opts.rbacFlag,
    });
  }
  if (opts.scopeGrants !== undefined) {
    db.insert("organizationSetting", {
      organizationId: ORG,
      key: SCOPE_GRANTS_KEY,
      value: JSON.stringify(opts.scopeGrants),
    });
  }
  for (const [key, value] of Object.entries(opts.settings ?? {})) {
    db.insert("organizationSetting", { organizationId: ORG, key, value });
  }

  db.insert(
    "channel",
    {
      id: "ch_1",
      organizationId: ORG,
      name: "WhatsApp Vendas",
      type: "WHATSAPP",
      provider: "META_CLOUD_API",
      phoneNumber: "+5511999990001",
      status: "CONNECTED",
      config: {},
    },
    {
      id: "ch_2",
      organizationId: ORG,
      name: "WhatsApp Suporte",
      type: "WHATSAPP",
      provider: "META_CLOUD_API",
      phoneNumber: "+5511999990002",
      status: "CONNECTED",
      config: {},
    },
    {
      id: "ch_foreign",
      organizationId: OTHER_ORG,
      name: "Outra org",
      type: "WHATSAPP",
      provider: "META_CLOUD_API",
      phoneNumber: "+5511999990009",
      status: "CONNECTED",
      config: {},
    },
  );

  db.insert(
    "contact",
    { id: "ct_1", organizationId: ORG, assignedToId: null },
    { id: "ct_2", organizationId: ORG, assignedToId: null },
    { id: "ct_3", organizationId: ORG, assignedToId: null },
    { id: "ct_4", organizationId: ORG, assignedToId: null },
    { id: "ct_foreign", organizationId: OTHER_ORG, assignedToId: null },
  );
  db.insert("stage", { id: "st_1", pipelineId: "p_1" }, { id: "st_2", pipelineId: "p_2" });
  db.insert(
    "deal",
    { id: "d_1", organizationId: ORG, contactId: "ct_1", ownerId: USERS.other.id, stageId: "st_1" },
    { id: "d_4", organizationId: ORG, contactId: "ct_4", ownerId: USERS.member.id, stageId: "st_2" },
  );

  const convBase = {
    organizationId: ORG,
    externalId: null,
    waJid: null,
    channel: "whatsapp",
    channelId: "ch_1",
    departmentId: null,
    pinnedNoteId: null,
    hasError: false,
    hasAgentReply: true,
    hasHumanReply: true,
    lastMessageDirection: "in",
    lastInboundAt: at(-5),
    closedAt: null,
  };
  db.insert(
    "conversation",
    {
      ...convBase,
      id: CONV.mine,
      number: 101,
      contactId: "ct_1",
      status: "OPEN",
      assignedToId: USERS.member.id,
      createdAt: at(-600),
    },
    {
      ...convBase,
      id: CONV.resolved,
      number: 90,
      contactId: "ct_1",
      status: "RESOLVED",
      assignedToId: USERS.member.id,
      createdAt: at(-6000),
      closedAt: at(-5000),
    },
    {
      ...convBase,
      id: CONV.others,
      number: 102,
      contactId: "ct_2",
      status: "OPEN",
      assignedToId: USERS.other.id,
      createdAt: at(-500),
    },
    {
      ...convBase,
      id: CONV.queue,
      number: 103,
      contactId: "ct_3",
      status: "OPEN",
      assignedToId: null,
      hasAgentReply: false,
      hasHumanReply: false,
      createdAt: at(-400),
    },
    {
      ...convBase,
      id: CONV.dealOwner,
      number: 104,
      contactId: "ct_4",
      status: "OPEN",
      assignedToId: USERS.other.id,
      createdAt: at(-300),
    },
    {
      ...convBase,
      id: CONV.foreign,
      number: 101,
      organizationId: OTHER_ORG,
      contactId: "ct_foreign",
      channelId: "ch_foreign",
      status: "OPEN",
      assignedToId: "u_foreign",
      createdAt: at(-300),
    },
  );

  const msgBase = {
    organizationId: ORG,
    messageType: "text",
    isPrivate: false,
    authorType: "human",
    triggeredByName: null,
    mediaUrl: null,
    replyToId: null,
    replyToPreview: null,
    reactions: null,
    sendStatus: "sent",
    sendError: null,
    channelId: "ch_1",
    catalogOrder: null,
  };
  const addThread = (conversationId: string, prefix: string, sender: string) => {
    db.insert(
      "message",
      {
        ...msgBase,
        id: `${prefix}1`,
        externalId: `wamid.${prefix}1`,
        conversationId,
        content: "Olá, quero saber do curso",
        direction: "in",
        senderName: "Cliente",
        createdAt: at(-60),
      },
      {
        ...msgBase,
        id: `${prefix}2`,
        externalId: `wamid.${prefix}2`,
        conversationId,
        content: "Claro! Qual curso?",
        direction: "out",
        senderName: sender,
        sendStatus: "read",
        createdAt: at(-59),
      },
      {
        ...msgBase,
        id: `${prefix}3`,
        externalId: `wamid.${prefix}3`,
        conversationId,
        content: "Administração",
        direction: "in",
        senderName: "Cliente",
        replyToId: `${prefix}2`,
        replyToPreview: "Claro! Qual curso?",
        createdAt: at(-58),
      },
      {
        ...msgBase,
        id: `${prefix}4`,
        externalId: `wamid.${prefix}4`,
        conversationId,
        content: "Segue a grade",
        direction: "out",
        senderName: sender,
        sendStatus: "delivered",
        createdAt: at(-57),
      },
      {
        ...msgBase,
        id: `${prefix}5`,
        externalId: null,
        conversationId,
        content: "Conversa atribuída a Ana Lima",
        direction: "system",
        messageType: "event:atribuicao",
        authorType: "system",
        senderName: "Sistema",
        channelId: null,
        createdAt: at(-56),
      },
      {
        ...msgBase,
        id: `${prefix}6`,
        externalId: `wamid.${prefix}6`,
        conversationId,
        content: "Obrigado!",
        direction: "in",
        senderName: "Cliente",
        createdAt: at(-5),
      },
    );
  };
  addThread(CONV.mine, "m", USERS.member.name);
  addThread(CONV.others, "o", USERS.other.name);
  addThread(CONV.queue, "q", USERS.other.name);
  addThread(CONV.dealOwner, "w", USERS.other.name);

  db.insert("pinnedMessage", {
    id: "pin_1",
    conversationId: CONV.mine,
    messageId: "m2",
    expiresAt: null,
    createdAt: at(-30),
  });
  db.insert("favoriteMessage", {
    id: "fav_1",
    organizationId: ORG,
    userId: USERS.member.id,
    messageId: "m4",
  });

  opts.mutate?.(db);
  return db;
}

/** Sessão no formato que `auth()` devolve. */
export function sessionFor(key: FixtureUserKey, overrides: Record<string, unknown> = {}) {
  const u = USERS[key];
  return {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      organizationId: ORG,
      isSuperAdmin: false,
      ...overrides,
    },
  };
}
