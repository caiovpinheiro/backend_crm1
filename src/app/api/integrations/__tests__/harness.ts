/**
 * Mundo de teste das rotas `/api/integrations/*`: banco em memória com
 * `where` de verdade (`FakeDb`), ESCOPADO pela organização do
 * `RequestContext` — o papel da extension de tenant do Prisma —, mais os
 * dublês de autenticação (sessão, token Bearer), permissões e fila.
 *
 * Sem `vi.mock` aqui: cada arquivo de teste declara os seus e aponta para
 * as fábricas deste módulo.
 */
import { NextResponse } from "next/server";

import { getRequestContext } from "@/lib/request-context";
import { FakeDb, type FakeDbSchema } from "@/test-setup/fake-db";

type Row = Record<string, unknown>;
type Args = Record<string, unknown> | undefined;

const SCHEMA: FakeDbSchema = {
  campaign: {
    channel: { kind: "one", table: "channel", localKey: "channelId" },
    segment: { kind: "one", table: "segment", localKey: "segmentId" },
    automation: { kind: "one", table: "automation", localKey: "automationId" },
    createdBy: { kind: "one", table: "user", localKey: "createdById" },
  },
  campaignRecipient: {
    contact: { kind: "one", table: "contact", localKey: "contactId" },
  },
  conversation: {
    contact: { kind: "one", table: "contact", localKey: "contactId" },
    assignedTo: { kind: "one", table: "user", localKey: "assignedToId" },
  },
  agentStatus: {
    user: { kind: "one", table: "user", localKey: "userId" },
  },
};

/** `User` não é tenant-scoped no Prisma real: o filtro por org é explícito. */
const UNSCOPED = new Set(["user"]);

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
};

export const world = {
  db: new FakeDb(SCHEMA),
  session: null as { user: SessionUser } | null,
  tokens: new Map<string, SessionUser>(),
  permissions: new Map<string, string[]>(),
  queueUp: true,
  dispatched: [] as unknown[],
  sends: [] as unknown[],
  seq: 0,
};

function ctxOrg(): string {
  const org = getRequestContext()?.organizationId;
  if (!org) throw new Error("[harness] consulta sem organização no RequestContext");
  return org;
}

function scoped(model: string, args: Args): Record<string, unknown> {
  const a = args ?? {};
  if (UNSCOPED.has(model)) return a;
  return { ...a, where: { AND: [a.where ?? {}, { organizationId: ctxOrg() }] } };
}

function pick(row: Row, spec: unknown): Row {
  const select = typeof spec === "object" && spec ? (spec as { select?: Row }).select : undefined;
  if (!select) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) out[key] = row[key] ?? null;
  return out;
}

function attach(model: string, row: Row, include: unknown): Row {
  if (!include || typeof include !== "object") return row;
  const out = { ...row };
  for (const [key, spec] of Object.entries(include)) {
    if (!spec) continue;
    const rel = SCHEMA[model]?.[key];
    if (!rel || rel.kind !== "one") throw new Error(`[harness] include desconhecido: ${model}.${key}`);
    const target = world.db.table(rel.table).find((r) => r.id === row[rel.localKey]);
    out[key] = target ? pick(target, spec) : null;
  }
  return out;
}

function findMany(model: string, args: Args): Row[] {
  const { include, skip, take, ...rest } = args ?? {};
  let rows = world.db.run(model, "findMany", scoped(model, rest)) as Row[];
  if (typeof skip === "number") rows = rows.slice(skip);
  if (typeof take === "number") rows = rows.slice(0, take);
  return include ? rows.map((r) => attach(model, r, include)) : rows;
}

/** Linhas reais da tabela (não cópias) que batem com o `where` escopado. */
function liveRows(model: string, where: unknown): Row[] {
  const full = scoped(model, { where }).where as Record<string, unknown>;
  return world.db.table(model).filter((r) => world.db.matches(model, r, full));
}

function delegate(model: string) {
  return {
    findUnique: async (args: Args) => findMany(model, { ...args, take: 1 })[0] ?? null,
    findFirst: async (args: Args) => findMany(model, { ...args, take: 1 })[0] ?? null,
    findMany: async (args: Args) => findMany(model, args),
    count: async (args: Args) => world.db.run(model, "count", scoped(model, args)),
    create: async (args: { data: Row }) => {
      if (!UNSCOPED.has(model) && args.data.organizationId !== ctxOrg()) {
        throw new Error("[harness] create com organizationId diferente do contexto");
      }
      const row: Row = { id: `${model}-${++world.seq}`, createdAt: new Date(), ...args.data };
      for (const [k, v] of Object.entries(row)) if (v === undefined) row[k] = null;
      if (model === "campaign") {
        Object.assign(row, { status: "DRAFT", sentCount: 0, failedCount: 0, totalRecipients: 0 });
      }
      world.db.insert(model, row);
      return { ...row };
    },
    update: async (args: { where: unknown; data: Row }) => {
      const row = liveRows(model, args.where)[0];
      if (!row) throw Object.assign(new Error("registro não encontrado"), { code: "P2025" });
      Object.assign(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where: unknown; data: Row }) => {
      const rows = liveRows(model, args.where);
      for (const row of rows) Object.assign(row, args.data);
      return { count: rows.length };
    },
    groupBy: async (args: { by: string[]; where: unknown }) => {
      const groups = new Map<unknown, number>();
      for (const row of liveRows(model, args.where)) {
        const key = row[args.by[0]!] ?? null;
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      return [...groups].map(([value, n]) => ({ [args.by[0]!]: value, _count: { _all: n } }));
    },
  };
}

const delegates = new Map<string, ReturnType<typeof delegate>>();
export const fakePrisma = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (!delegates.has(prop)) delegates.set(prop, delegate(prop));
      return delegates.get(prop);
    },
  },
);

// ── Fábricas dos módulos mockados ────────────────────────────────────────

export const prismaModule = { prisma: fakePrisma };
export const analyticsModule = { analyticsClient: () => fakePrisma };
export const authModule = { auth: async () => world.session };

export const apiTokensModule = {
  validateToken: async (raw: string) => {
    const user = world.tokens.get(raw);
    if (!user) return null;
    return {
      tokenId: `tok-${user.id}`,
      tokenHash: `hash-${raw}`,
      tokenName: `token de ${user.name}`,
      organizationId: user.organizationId,
      user,
    };
  },
};

export const queueModule = {
  enqueueCampaignDispatch: async (payload: unknown, delay?: number) => {
    if (!world.queueUp) return null;
    world.dispatched.push({ payload, delay });
    return { id: "job-1" };
  },
  enqueueCampaignSend: async (payload: unknown) => {
    world.sends.push(payload);
    return { id: "job-2" };
  },
};

export const auditModule = {
  logApiAccessAuthReject: () => undefined,
  logApiAccessRequireAuthFail: async () => undefined,
  logApiAccessCompleted: async () => undefined,
  readApiAccessHeaders: async () => ({ method: "GET", path: "", requestToken: undefined }),
  resolveResponseStatus: (out: unknown) => (out instanceof Response ? out.status : 200),
};

export const rateLimitModule = {
  consumeRateLimit: async () => ({
    allowed: true,
    limit: 240,
    remaining: 239,
    resetAt: Date.now() + 60_000,
    retryAfterSec: 0,
  }),
};

/**
 * `@/lib/authz` real, trocando só a carga do contexto (que leria cache e
 * banco) pelas permissões do mundo de teste. `can()` continua o de produção.
 */
export function authzModule<T extends { can: (ctx: never, key: string) => boolean }>(original: T) {
  const loadAuthzContext = async (input: {
    userId: string;
    organizationId: string | null;
    isSuperAdmin: boolean;
  }) => {
    const permissions = world.permissions.get(input.userId) ?? [];
    return {
      ...input,
      isAdmin: permissions.includes("*"),
      permissions: new Set(permissions),
      stageView: null,
      stageDeny: new Set<string>(),
      pipelineDeny: new Set<string>(),
      stageEdit: null,
      fieldDenyView: new Set<string>(),
      fieldDenyEdit: new Set<string>(),
      sharedInbox: true,
      mediaAccess: true,
      seeTeam: false,
      seeUnassigned: false,
    };
  };
  return {
    ...original,
    loadAuthzContext,
    requirePermission: async (
      user: { id: string; organizationId: string | null; isSuperAdmin: boolean },
      key: string,
    ) => {
      const ctx = await loadAuthzContext({
        userId: user.id,
        organizationId: user.organizationId,
        isSuperAdmin: user.isSuperAdmin,
      });
      if (original.can(ctx as never, key)) return null;
      return NextResponse.json({ message: "Acesso negado.", required: key }, { status: 403 });
    },
  };
}

// ── Cenário ──────────────────────────────────────────────────────────────

export const TOKEN_A = "eduit_org_a_admin";
export const TOKEN_A_SEM_PERMISSAO = "eduit_org_a_sem_permissao";
export const TOKEN_B = "eduit_org_b_admin";

function user(id: string, organizationId: string): SessionUser {
  return { id, name: id, email: `${id}@teste.local`, role: "MEMBER", organizationId, isSuperAdmin: false };
}

export const USER_A = user("user-a", "org-a");
export const USER_A_SEM_PERMISSAO = user("user-a-sem", "org-a");
export const USER_B = user("user-b", "org-b");

export function resetWorld(): void {
  world.db = new FakeDb(SCHEMA);
  world.session = null;
  world.queueUp = true;
  world.dispatched = [];
  world.sends = [];
  world.seq = 0;
  world.tokens = new Map([
    [TOKEN_A, USER_A],
    [TOKEN_A_SEM_PERMISSAO, USER_A_SEM_PERMISSAO],
    [TOKEN_B, USER_B],
  ]);
  world.permissions = new Map([
    [USER_A.id, ["*"]],
    [USER_A_SEM_PERMISSAO.id, []],
    [USER_B.id, ["*"]],
  ]);
  world.db.insert(
    "user",
    { ...USER_A, type: "HUMAN" },
    { ...USER_A_SEM_PERMISSAO, type: "HUMAN" },
    { ...USER_B, type: "HUMAN" },
  );
  for (const org of ["a", "b"]) {
    world.db.insert("channel", {
      id: `channel-${org}`,
      organizationId: `org-${org}`,
      name: `Canal ${org}`,
      provider: "META_CLOUD_API",
      type: "WHATSAPP",
      status: "CONNECTED",
      config: { accessToken: "segredo-do-canal" },
    });
    world.db.insert("segment", {
      id: `segment-${org}`,
      organizationId: `org-${org}`,
      name: `Segmento ${org}`,
      filters: { tagIds: ["tag-1"] },
    });
  }
}

export function addCampaign(overrides: Row = {}): Row {
  const row: Row = {
    id: `camp-${++world.seq}`,
    organizationId: "org-a",
    name: "Campanha",
    status: "DRAFT",
    type: "TEMPLATE",
    useLastConversationChannel: false,
    channelId: "channel-a",
    segmentId: null,
    filters: { tagIds: ["tag-1"] },
    templateName: "aviso",
    templateLanguage: "pt_BR",
    templateComponents: null,
    textContent: null,
    automationId: null,
    sendRate: 20,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    totalRecipients: 0,
    sentCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    readCount: 0,
    repliedCount: 0,
    createdById: USER_A.id,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
  world.db.insert("campaign", row);
  return row;
}

export function campaignRow(id: string): Row | undefined {
  return world.db.table("campaign").find((r) => r.id === id);
}

const BASE = "https://integrations.test";

export function request(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

export function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
