/**
 * Identify ASSINADO (docs/decisoes/webchat-widget.md §9.4) pela rota real
 * `POST /api/public/webchat/session/identify`: token real (jose), segredo
 * real (encriptado no config), HMAC real. Banco em memória com ESCOPO DE
 * ORG (o `prisma` scoped só enxerga a org do contexto aberto pela rota).
 * Dados neutros (`ext-1`, `campo`, …).
 */
import { createHmac, randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const m = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  const ctx = { org: null as string | null };
  const db = {
    contacts: [] as Row[],
    customFields: [] as Row[],
    cfValues: [] as Row[],
    sessions: [] as Row[],
    channels: [] as Row[],
    seq: 0,
  };

  function cond(v: unknown, c: unknown): boolean {
    if (c !== null && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c)) {
      const o = c as Row;
      if ("not" in o) return o.not === null ? v !== null && v !== undefined : v !== o.not;
      if ("in" in o) return (o.in as unknown[]).includes(v);
      if ("equals" in o) return v === o.equals;
      return false;
    }
    return v === c;
  }
  /** `where` simples + escopo de org (como o prisma scoped). */
  function hit(row: Row, where: Row | undefined): boolean {
    if (ctx.org && row.organizationId !== ctx.org) return false;
    if (!where) return true;
    return Object.entries(where).every(([k, c]) => cond(row[k], c));
  }
  function pick(row: Row | undefined, select?: Row): Row | null {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const k of Object.keys(select)) out[k] = row[k];
    return out;
  }

  const prisma = {
    contact: {
      findFirst: vi.fn(async ({ where, select }: { where?: Row; select?: Row }) =>
        pick(db.contacts.find((c) => hit(c, where)), select),
      ),
      findUnique: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        pick(db.contacts.find((c) => hit(c, { id: where.id })), select),
      ),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.contacts.find((c) => hit(c, { id: where.id }));
        if (!row) throw new Error("contato não existe");
        if (data.externalId) {
          const dup = db.contacts.find(
            (c) => c.organizationId === row.organizationId && c.id !== row.id && c.externalId === data.externalId,
          );
          if (dup) {
            throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
          }
        }
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = db.contacts.filter((c) => hit(c, where));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
    },
    customField: {
      findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        pick(db.customFields.find((f) => hit(f, where)), select),
      ),
      findMany: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        db.customFields.filter((f) => hit(f, where)).map((f) => pick(f, select)),
      ),
    },
    contactCustomFieldValue: {
      findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        pick(db.cfValues.find((v) => hit(v, where)), select),
      ),
      upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const key = where.contactId_customFieldId as Row;
        const row = db.cfValues.find((v) => v.contactId === key.contactId && v.customFieldId === key.customFieldId);
        if (row) Object.assign(row, update);
        else db.cfValues.push({ organizationId: ctx.org, ...create });
        return {};
      }),
    },
    conversation: { findFirst: vi.fn(async () => null) },
    deal: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    channel: {
      findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        pick(db.channels.find((c) => hit(c, where)), select),
      ),
    },
    webchatSession: {
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.sessions.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
      findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) =>
        pick(db.sessions.find((s) => hit(s, where)), select),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const prismaBase = {
    channel: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const c = db.channels.find((x) => x.id === where.id || x.publicKey === where.publicKey);
        return c ? { ...c, organization: { status: "ACTIVE", primaryColor: null, logoUrl: null } } : null;
      }),
    },
    webchatSession: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => {
        const s = db.sessions.find((x) => x.id === where.id);
        return s ? { ...s } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.sessions.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
    },
  };

  return {
    logger,
    ctx,
    db,
    prisma,
    prismaBase,
    insertContact: vi.fn(async (data: Row) => {
      const row: Row = { id: `ct-new-${++db.seq}`, organizationId: ctx.org, externalId: null, ...data };
      db.contacts.push(row);
      return { id: row.id, name: row.name };
    }),
    mergeContacts: vi.fn(async (keepId: string, removeId: string) => ({
      ok: true,
      result: { keptId: keepId, removedId: removeId },
    })),
    adopt: vi.fn(async () => {}),
    findDuplicates: vi.fn(async () => []),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => m.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: m.prisma }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: m.prismaBase }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: Row) => ({ organizationId: m.ctx.org, ...d }) }));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: async (org: string, fn: () => Promise<unknown>) => {
    const prev = m.ctx.org;
    m.ctx.org = org;
    try {
      return await fn();
    } finally {
      m.ctx.org = prev;
    }
  },
}));
vi.mock("@/lib/cache", () => ({ cache: { get: async () => undefined, set: async () => {} } }));
vi.mock("@/lib/cache/keys", () => ({
  wrapChannelLookup: (_k: string, _t: number, loader: () => Promise<unknown>) => loader(),
  invalidateBoardData: vi.fn(async () => {}),
}));
vi.mock("@/lib/cache/message-versions", () => ({
  noteMessageChange: vi.fn(async () => {}),
  noteMessageRowChange: vi.fn(async () => {}),
}));
vi.mock("@/lib/realtime-events", () => ({
  publishContactUpdated: vi.fn(),
  publishConversationUpdated: vi.fn(),
  publishNewMessage: vi.fn(),
}));
vi.mock("@/lib/webchat/visitor-data", () => ({ adoptAnonymousVisitorData: m.adopt }));
vi.mock("@/lib/webchat/duplicate-notice", () => ({
  findPossibleDuplicates: m.findDuplicates,
  recordPossibleDuplicateNotice: vi.fn(async () => null),
  notePossibleDuplicatesInConversation: vi.fn(async () => {}),
}));
vi.mock("@/services/merge-contacts", () => ({ mergeContacts: m.mergeContacts }));
vi.mock("@/services/contacts", () => ({
  insertContactWithNextNumber: m.insertContact,
  isPrismaUniqueViolation: () => false,
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => {}),
  buildMessageTriggerData: (d: unknown) => d,
  emitConversationCreated: vi.fn(),
  openingMessageTriggerExtra: () => ({}),
}));
// Dependências do inbound que o identify não exercita.
vi.mock("@/lib/web-push", () => ({ notifyInboundMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/conversation-inbound", () => ({ touchInbound: vi.fn(), warnTouchInboundFailed: vi.fn() }));
vi.mock("@/lib/message-dedup", () => ({ createMessageDedup: vi.fn() }));
vi.mock("@/services/ai/attendance-gate", () => ({ inheritContactAssigneeForNewTicket: async () => null }));
vi.mock("@/services/ai/turn-manager", () => ({ onInboundMessageForAi: vi.fn(async () => {}) }));
vi.mock("@/services/auto-deals", () => ({ ensureOpenDealForContact: vi.fn(async () => {}) }));
vi.mock("@/services/conversations", () => ({
  activeConversationOnAccountWhere: (a: unknown) => a,
  isActiveConversationUniqueViolation: () => false,
  withConversationNumberRetry: (fn: (n: number) => Promise<unknown>) => fn(1),
}));
vi.mock("@/services/distribution", () => ({ maybeDistributeNewInboundTicket: vi.fn(async () => {}) }));

import { POST as postIdentify } from "@/app/api/public/webchat/session/identify/route";
import { resetRateLimitersForTests } from "@/lib/rate-limit";
import { checkWebchatSignature, mapWebchatAttributes } from "@/lib/webchat/identify-signed";
import { withRotatedWebchatSecret } from "@/lib/webchat/secrets";
import { signWebchatToken } from "@/lib/webchat/token";
import { defaultWebchatV2Config } from "@/lib/webchat/v2-config";

const KEY = "wc_ABCDEFGHIJKLMNOPQRSTUVWX";
let SECRET = "";

const hash = (secret: string, externalId: string) =>
  createHmac("sha256", secret).update(externalId).digest("hex");

function seedChannel(opts: { withSecret?: boolean; org?: string; v2?: Row } = {}) {
  const base: Row = {
    allowedOrigins: [],
    v2: opts.v2 ?? {
      identity: {
        matchField: { type: "externalId" },
        attributeMap: [{ attribute: "campo", customFieldId: "cf-1" }],
      },
    },
  };
  let config = base;
  if (opts.withSecret !== false) {
    const rotated = withRotatedWebchatSecret(base, "identity");
    SECRET = rotated.plain;
    config = rotated.config;
  }
  m.db.channels.push({
    id: "ch-1",
    organizationId: opts.org ?? "org-1",
    name: "Site",
    publicKey: KEY,
    provider: "WEBCHAT",
    status: "CONNECTED",
    defaultPipelineId: null,
    config,
  });
}

async function seedSession(contactId: string | null = null) {
  const { token, tokenHash } = await signWebchatToken({ org: "org-1", ch: "ch-1", vis: "wv_v1", cid: contactId });
  m.db.sessions.push({
    id: "wv_v1",
    organizationId: "org-1",
    channelId: "ch-1",
    contactId,
    tokenHash,
    prevTokenHash: null,
    rotatedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    lastSeenAt: new Date(),
    firstUrl: null,
    lastUrl: null,
    referrer: null,
    utm: null,
    createdAt: new Date(),
    identityVerifiedAt: null,
  });
  return token;
}

function identify(token: string, body: Row) {
  return postIdentify(
    new Request("https://bwipo.com/api/public/webchat/session/identify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify(body),
    }),
  );
}

const session = () => m.db.sessions[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitersForTests();
  process.env.AUTH_SECRET = "test-auth-secret-for-webchat-identify";
  process.env.TENANT_BASE_DOMAIN = "bwipo.com";
  process.env.KEYRING_SECRET = randomBytes(32).toString("base64");
  m.ctx.org = null;
  m.db.contacts = [];
  m.db.customFields = [{ id: "cf-1", organizationId: "org-1", entity: "contact" }];
  m.db.cfValues = [];
  m.db.sessions = [];
  m.db.channels = [];
  m.db.seq = 0;
});

describe("checkWebchatSignature / mapWebchatAttributes (puras)", () => {
  it("válida, inválida, ausente e sem segredo", () => {
    const secret = "wcid_segredo-de-teste";
    expect(checkWebchatSignature({ identitySecret: secret, externalId: "ext-1", userHash: hash(secret, "ext-1") }))
      .toEqual({ verified: true, externalId: "ext-1" });
    expect(
      checkWebchatSignature({ identitySecret: secret, externalId: "ext-1", userHash: hash(secret, "ext-1").toUpperCase() }),
    ).toEqual({ verified: true, externalId: "ext-1" });
    expect(checkWebchatSignature({ identitySecret: secret, externalId: "ext-2", userHash: hash(secret, "ext-1") }))
      .toEqual({ verified: false, reason: "SIGNATURE_INVALID" });
    expect(checkWebchatSignature({ identitySecret: secret, externalId: "ext-1", userHash: "abc" }))
      .toEqual({ verified: false, reason: "SIGNATURE_INVALID" });
    expect(checkWebchatSignature({ identitySecret: secret, externalId: "ext-1", userHash: undefined }))
      .toEqual({ verified: false, reason: "SIGNATURE_MISSING" });
    expect(checkWebchatSignature({ identitySecret: null, externalId: "ext-1", userHash: hash(secret, "ext-1") }))
      .toEqual({ verified: false, reason: "IDENTITY_NOT_CONFIGURED" });
  });

  it("atributos: só os mapeados, valores simples, cortados no limite", () => {
    const cfg = defaultWebchatV2Config();
    cfg.identity.attributeMap = [
      { attribute: "campo", customFieldId: "cf-1" },
      { attribute: "nivel", customFieldId: "cf-2" },
      { attribute: "ativo", customFieldId: "cf-3" },
    ];
    cfg.context.maxValueChars = 5;
    expect(
      mapWebchatAttributes(
        { campo: "valor longo\ncom quebra", nivel: 3, ativo: true, outro: "x", vazio: null, obj: { a: 1 } },
        cfg,
      ),
    ).toEqual([
      { customFieldId: "cf-1", value: "valor" },
      { customFieldId: "cf-2", value: "3" },
      { customFieldId: "cf-3", value: "true" },
    ]);
    expect(mapWebchatAttributes(["x"], cfg)).toEqual([]);
  });
});

describe("POST /session/identify — assinatura válida", () => {
  it("liga a sessão ao contato do externalId, funde o anônimo, adota o contexto e mapeia atributos", async () => {
    seedChannel();
    m.db.contacts.push(
      { id: "ct-site", organizationId: "org-1", name: "Pessoa Um", email: "um@exemplo.test", phone: null, externalId: "ext-1" },
      { id: "ct-anon", organizationId: "org-1", name: "Visitante wv_v1", email: null, phone: null, externalId: null, webchatVisitorId: "wv_v1" },
    );
    const token = await seedSession("ct-anon");

    const res = await identify(token, {
      externalId: "ext-1",
      userHash: hash(SECRET, "ext-1"),
      name: "Outro Nome",
      phone: "+55 11 90000-0001",
      attributes: { campo: "A", semMapa: "ignorado" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ verified: true, contactId: "ct-site", merged: false });
    expect(body.reason).toBeUndefined();
    expect(body.contact).toMatchObject({ name: "Pessoa Um", email: "um@exemplo.test", identified: true });

    expect(session()).toMatchObject({ contactId: "ct-site" });
    expect(session().identityVerifiedAt).toBeInstanceOf(Date);
    expect(m.mergeContacts).toHaveBeenCalledWith("ct-site", "ct-anon");
    expect(m.adopt).toHaveBeenCalledWith(expect.anything(), { sessionId: "wv_v1", contactId: "ct-site" });
    // Nome já preenchido não muda; telefone vazio é preenchido.
    const site = m.db.contacts.find((c) => c.id === "ct-site")!;
    expect(site.name).toBe("Pessoa Um");
    expect(site.phone).toBeTruthy();
    expect(m.db.cfValues).toEqual([
      expect.objectContaining({ contactId: "ct-site", customFieldId: "cf-1", value: "A" }),
    ]);
  });

  it("externalId desconhecido: o contato do próprio visitante recebe a identidade (sem fundir)", async () => {
    seedChannel();
    const token = await seedSession(null);
    const res = await identify(token, { externalId: "ext-novo", userHash: hash(SECRET, "ext-novo") });
    const body = await res.json();
    expect(body.verified).toBe(true);
    const created = m.db.contacts.find((c) => c.externalId === "ext-novo")!;
    expect(created).toMatchObject({ organizationId: "org-1", webchatVisitorId: "wv_v1", source: "Webchat" });
    expect(body.contactId).toBe(created.id);
    expect(session().contactId).toBe(created.id);
    expect(m.mergeContacts).not.toHaveBeenCalled();
  });

  it("campo de match personalizado: procura e grava no campo configurado", async () => {
    seedChannel({ v2: { identity: { matchField: { type: "customField", customFieldId: "cf-1" }, attributeMap: [] } } });
    m.db.contacts.push({ id: "ct-cf", organizationId: "org-1", name: "Pessoa Dois", externalId: null });
    m.db.cfValues.push({ organizationId: "org-1", contactId: "ct-cf", customFieldId: "cf-1", value: "ext-9" });
    const token = await seedSession(null);
    const body = await (await identify(token, { externalId: "ext-9", userHash: hash(SECRET, "ext-9") })).json();
    expect(body).toMatchObject({ verified: true, contactId: "ct-cf" });
  });
});

describe("POST /session/identify — sem assinatura válida (nunca liga nem funde)", () => {
  async function unverified(body: Row, opts: { withSecret?: boolean } = {}) {
    seedChannel(opts);
    m.db.contacts.push({ id: "ct-site", organizationId: "org-1", name: "Pessoa Um", email: null, externalId: "ext-1" });
    const token = await seedSession(null);
    const res = await identify(token, body);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.verified).toBe(false);
    expect(session().contactId).not.toBe("ct-site");
    expect(session().identityVerifiedAt).toBeNull();
    expect(m.mergeContacts).not.toHaveBeenCalled();
    expect(m.adopt).not.toHaveBeenCalled();
    expect(m.db.contacts.find((c) => c.id === "ct-site")).toMatchObject({ name: "Pessoa Um", email: null });
    expect(m.db.cfValues).toEqual([]);
    return out;
  }

  it("assinatura inválida → SIGNATURE_INVALID; o nome digitado vai só para o contato próprio", async () => {
    const out = await unverified({
      externalId: "ext-1",
      userHash: "0".repeat(64),
      name: "Digitado",
      attributes: { campo: "A" },
    });
    expect(out.reason).toBe("SIGNATURE_INVALID");
    const own = m.db.contacts.find((c) => c.webchatVisitorId === "wv_v1")!;
    expect(own).toMatchObject({ name: "Digitado", externalId: null });
    expect(out.contactId).toBe(own.id);
  });

  it("assinatura ausente → SIGNATURE_MISSING (sem dados: nada é criado)", async () => {
    const out = await unverified({ externalId: "ext-1" });
    expect(out.reason).toBe("SIGNATURE_MISSING");
    expect(m.insertContact).not.toHaveBeenCalled();
  });

  it("canal sem segredo de identidade → IDENTITY_NOT_CONFIGURED", async () => {
    const out = await unverified({ externalId: "ext-1", userHash: "a".repeat(64) }, { withSecret: false });
    expect(out.reason).toBe("IDENTITY_NOT_CONFIGURED");
  });

  it("v1 sem campos de assinatura e sem dados → 400", async () => {
    seedChannel();
    const token = await seedSession(null);
    expect((await identify(token, {})).status).toBe(400);
  });
});

describe("isolamento de org", () => {
  it("o mesmo externalId em OUTRA org nunca é encontrado nem ligado", async () => {
    seedChannel();
    m.db.contacts.push({ id: "ct-outra", organizationId: "org-2", name: "Outra Org", externalId: "ext-1" });
    const token = await seedSession(null);
    const body = await (await identify(token, { externalId: "ext-1", userHash: hash(SECRET, "ext-1") })).json();
    expect(body.verified).toBe(true);
    expect(body.contactId).not.toBe("ct-outra");
    const mine = m.db.contacts.find((c) => c.id === body.contactId)!;
    expect(mine).toMatchObject({ organizationId: "org-1", externalId: "ext-1" });
    expect(m.db.contacts.find((c) => c.id === "ct-outra")).toMatchObject({ name: "Outra Org" });
    expect(m.mergeContacts).not.toHaveBeenCalled();
  });
});
