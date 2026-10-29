/**
 * Rotas públicas do webchat: token (401), origem (403), rate limit (429) e
 * cursor do `GET /messages`. Tokens reais (jose); banco mockado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    prismaBase: {
      channel: { findUnique: vi.fn() },
      webchatSession: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn<(args: { where?: unknown; data: Record<string, unknown> }) => Promise<unknown>>(
          async () => ({}),
        ),
      },
      systemUsageSession: { findFirst: vi.fn(async () => null) },
    },
    prisma: {
      message: {
        findMany: vi.fn(),
        findFirst: vi.fn(async (): Promise<unknown> => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      conversation: { findFirst: vi.fn(async (): Promise<unknown> => null) },
      contact: {
        findFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
        findUnique: vi.fn(async (): Promise<unknown> => null),
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      deal: {
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      webchatSession: {
        update: vi.fn(async (_a?: unknown) => ({})),
        findFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
      },
    },
    publishMessageStatus: vi.fn(),
    agentTyping: { value: undefined as number | undefined },
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: mocks.prismaBase }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/cache/keys", () => ({
  wrapChannelLookup: (_k: string, _t: number, loader: () => Promise<unknown>) => loader(),
}));
vi.mock("@/lib/cache", () => ({
  cache: {
    get: async (k: string) => (k.startsWith("webchat:agent_typing:") ? mocks.agentTyping.value : undefined),
    set: async () => {},
  },
}));
vi.mock("@/services/system-presence", () => ({ SYSTEM_PRESENCE_STALE_MS: 300_000 }));
vi.mock("@/lib/realtime-events", () => ({
  publishMessageStatus: mocks.publishMessageStatus,
  publishTypingEvent: vi.fn(() => true),
  publishNewMessage: vi.fn(),
  publishContactUpdated: vi.fn(),
  publishConversationUpdated: vi.fn(),
}));
vi.mock("@/lib/cache/message-versions", () => ({
  noteMessageChanges: vi.fn(async () => {}),
  noteMessageChange: vi.fn(async () => {}),
  noteMessageRowChange: vi.fn(async () => {}),
}));

import { GET as getConfig } from "@/app/api/public/webchat/config/route";
import { GET as getMessages } from "@/app/api/public/webchat/messages/route";
import { POST as postSession } from "@/app/api/public/webchat/session/route";
import { POST as postIdentify } from "@/app/api/public/webchat/session/identify/route";
import { POST as postMessage } from "@/app/api/public/webchat/messages/route";
import { hashWebchatToken } from "@/lib/webchat/token";
import { rateLimitIpKey } from "@/lib/webchat/http";
import { resetRateLimitersForTests } from "@/lib/rate-limit";
import { encodeVisitorCursor } from "@/lib/webchat/visitor-messages";
import { WEBCHAT_TOKEN_TTL_SEC, signWebchatToken } from "@/lib/webchat/token";

const KEY = "wc_ABCDEFGHIJKLMNOPQRSTUVWX";
const CHANNEL_ROW = {
  id: "ch-1",
  organizationId: "org-1",
  name: "Site",
  publicKey: KEY,
  provider: "WEBCHAT",
  status: "CONNECTED",
  defaultPipelineId: null,
  config: { allowedOrigins: ["https://www.cliente.com.br"], greeting: "Oi!" },
  organization: { status: "ACTIVE", primaryColor: "#123456", logoUrl: "https://cdn.test/logo.png" },
};

function sessionRow(tokenHash: string, over: Record<string, unknown> = {}) {
  return {
    id: "wv_v1",
    organizationId: "org-1",
    channelId: "ch-1",
    contactId: "ct-1",
    tokenHash,
    prevTokenHash: null,
    rotatedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    firstUrl: null,
    lastUrl: null,
    referrer: null,
    utm: null,
    createdAt: new Date(),
    ...over,
  };
}

async function visitorToken(now?: Date) {
  return signWebchatToken({ org: "org-1", ch: "ch-1", vis: "wv_v1", cid: "ct-1" }, now);
}

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return new Request(`https://api.bwipo.com${path}`, {
    ...init,
    headers: { "x-forwarded-for": "203.0.113.7", ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitersForTests();
  process.env.AUTH_SECRET = "test-auth-secret-for-webchat-routes";
  process.env.TENANT_BASE_DOMAIN = "bwipo.com";
  mocks.prismaBase.channel.findUnique.mockResolvedValue(CHANNEL_ROW);
  mocks.prisma.conversation.findFirst.mockResolvedValue(null);
  mocks.prisma.message.findFirst.mockResolvedValue(null);
  mocks.prisma.contact.findFirst.mockResolvedValue(null);
  mocks.prisma.contact.findMany.mockResolvedValue([]);
  delete process.env.WEBCHAT_SESSION_MAX_AGE_DAYS;
});

describe("GET /api/public/webchat/config", () => {
  it("devolve o config achatado (com allowedOrigins); online=false sem agente", async () => {
    const res = await getConfig(
      req(`/api/public/webchat/config?key=${KEY}&host=https://www.cliente.com.br`, {
        headers: { origin: "https://bwipo.com" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      online: false,
      greeting: "Oi!",
      publicKey: KEY,
      identification: "none",
      allowedOrigins: ["https://www.cliente.com.br"],
      channel: { name: "Site" },
    });
    // tema herdado da org (canal sem primary/avatarUrl)
    expect(body.theme).toEqual({
      primary: "#123456",
      avatarUrl: "https://cdn.test/logo.png",
      position: "right",
      title: "Fale conosco",
    });
  });

  it("host fora de allowedOrigins → 403", async () => {
    const res = await getConfig(
      req(`/api/public/webchat/config?key=${KEY}&host=https://evil.example`, {
        headers: { origin: "https://bwipo.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("Origin arbitrária (não é a página do widget nem permitida) → 403", async () => {
    const res = await getConfig(
      req(`/api/public/webchat/config?key=${KEY}`, { headers: { origin: "https://evil.example" } }),
    );
    expect(res.status).toBe(403);
  });

  it("allowedOrigins vazio: só a página hospedada (host do cliente → 403)", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue({ ...CHANNEL_ROW, config: {} });
    const hosted = await getConfig(
      req(`/api/public/webchat/config?key=${KEY}`, { headers: { origin: "https://bwipo.com" } }),
    );
    expect(hosted.status).toBe(200);
    const embedded = await getConfig(
      req(`/api/public/webchat/config?key=${KEY}&host=https://www.cliente.com.br`, {
        headers: { origin: "https://bwipo.com" },
      }),
    );
    expect(embedded.status).toBe(403);
  });

  it("chave desconhecida → 404", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue(null);
    const res = await getConfig(req(`/api/public/webchat/config?key=${KEY}`));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/public/webchat/messages — token", () => {
  it("sem Bearer → 401 TOKEN_MISSING", async () => {
    const res = await getMessages(req("/api/public/webchat/messages"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("TOKEN_MISSING");
  });

  it("token adulterado → 401 TOKEN_INVALID", async () => {
    const { token } = await visitorToken();
    const res = await getMessages(
      req("/api/public/webchat/messages", { headers: { authorization: `Bearer ${token}x` } }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("TOKEN_INVALID");
  });

  it("token vencido → 401 TOKEN_EXPIRED", async () => {
    const { token } = await visitorToken(new Date(Date.now() - (WEBCHAT_TOKEN_TTL_SEC + 10) * 1000));
    const res = await getMessages(
      req("/api/public/webchat/messages", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("TOKEN_EXPIRED");
  });

  it("token válido mas substituído (hash diferente na sessão) → 401", async () => {
    const { token } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow("outro-hash"));
    const res = await getMessages(
      req("/api/public/webchat/messages", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(401);
  });

  it("origem fora de allowedOrigins com token válido → 403", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash));
    const res = await getMessages(
      req("/api/public/webchat/messages", {
        headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/public/webchat/messages — cursor", () => {
  const t0 = new Date("2026-10-17T12:00:00.000Z");
  const row = (id: string, ms: number, direction: "in" | "out", sendStatus = "sent") => ({
    id,
    conversationId: "conv-1",
    externalId: direction === "in" ? `wc:wv_v1:c-${id}` : null,
    direction,
    content: `m ${id}`,
    messageType: "text",
    mediaUrl: null,
    createdAt: new Date(t0.getTime() + ms),
    senderName: direction === "out" ? "Agente Ana" : null,
    authorType: "human",
    sendStatus,
  });

  it("sem after: últimas em ordem cronológica; out sent → delivered; cursor = última", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash));
    // findMany desc
    mocks.prisma.message.findMany.mockResolvedValue([row("m2", 2000, "out"), row("m1", 1000, "in")]);
    const res = await getMessages(
      req("/api/public/webchat/messages", {
        headers: { authorization: `Bearer ${token}`, origin: "https://bwipo.com" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect(body.messages[0]).toMatchObject({ direction: "in", clientMessageId: "c-m1", status: null });
    expect(body.messages[1]).toMatchObject({ direction: "out", status: "delivered", senderName: "Agente Ana" });
    expect(body.cursor).toBe(encodeVisitorCursor(new Date(t0.getTime() + 2000), "m2"));
    expect(mocks.prisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m2"] }, sendStatus: "sent" },
      data: { sendStatus: "delivered" },
    });
    expect(mocks.publishMessageStatus).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", internalId: "m2", status: "delivered" }),
    );
    const where = mocks.prisma.message.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      conversation: { contactId: "ct-1", channel: "webchat", channelId: "ch-1" },
      isPrivate: false,
    });
  });

  it("com after: busca depois de (createdAt,id) em ordem asc; sem novidade mantém o cursor", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash));
    mocks.prisma.message.findMany.mockResolvedValue([]);
    const cursor = encodeVisitorCursor(new Date(t0.getTime() + 2000), "m2");
    const res = await getMessages(
      req(`/api/public/webchat/messages?after=${cursor}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ messages: [], cursor, hasMore: false, agentTyping: false, agentReadAt: null });
    const args = mocks.prisma.message.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(args.where.AND[1]).toEqual({
      OR: [
        { createdAt: { gt: new Date(t0.getTime() + 2000) } },
        { createdAt: new Date(t0.getTime() + 2000), id: { gt: "m2" } },
      ],
    });
  });

  it("after = id da última mensagem (fallback do widget); agentTyping/agentReadAt do ticket aberto", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash));
    mocks.prisma.message.findFirst.mockResolvedValue({ id: "m2", createdAt: new Date(t0.getTime() + 2000) });
    mocks.prisma.message.findMany.mockResolvedValue([row("m3", 3000, "out")]);
    mocks.prisma.conversation.findFirst.mockResolvedValue({
      id: "conv-1",
      lastReadAt: new Date(t0.getTime() + 2500),
    });
    mocks.agentTyping.value = 1;
    const res = await getMessages(
      req("/api/public/webchat/messages?after=m2", { headers: { authorization: `Bearer ${token}` } }),
    );
    mocks.agentTyping.value = undefined;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m3"]);
    expect(body.agentTyping).toBe(true);
    expect(body.agentReadAt).toBe(new Date(t0.getTime() + 2500).toISOString());
    expect(mocks.prisma.message.findMany.mock.calls[0][0].where.AND[1].OR[1]).toEqual({
      createdAt: new Date(t0.getTime() + 2000),
      id: { gt: "m2" },
    });
  });

  it("cursor malformado → 400", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash));
    const res = await getMessages(
      req("/api/public/webchat/messages?after=@@@", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/public/webchat/session — rate limit", () => {
  it("visitante novo: 10/min por IP, o 11º → 429", async () => {
    mocks.prismaBase.webchatSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...sessionRow(data.tokenHash as string, { id: data.id, contactId: null }),
    }));
    const call = () =>
      postSession(
        req("/api/public/webchat/session", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://bwipo.com" },
          body: JSON.stringify({ key: KEY, page: "https://www.cliente.com.br/curso" }),
        }),
      );
    for (let i = 0; i < 10; i++) {
      const ok = await call();
      expect(ok.status).toBe(200);
    }
    const first = mocks.prismaBase.webchatSession.create.mock.calls[0][0].data;
    expect(first).toMatchObject({ organizationId: "org-1", channelId: "ch-1", contactId: null });
    expect(first.id).toMatch(/^wv_[a-z0-9]{20}$/);
    expect(first.ipHash).toMatch(/^[0-9a-f]{32}$/);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("devolve token + visitorId + contactId null (abrir o chat não cria contato)", async () => {
    mocks.prismaBase.webchatSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...sessionRow(data.tokenHash as string, { id: data.id, contactId: null }),
    }));
    const res = await postSession(
      req("/api/public/webchat/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: KEY }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ contactId: null, conversation: null, renewed: false });
    expect(typeof body.token).toBe("string");
    expect(body.visitorId).toMatch(/^wv_/);
  });
});

// ── Renovação × criação: qual balde paga ───────────────────────────

function sessionCall(token: string | null, ip = "203.0.113.7") {
  return postSession(
    req("/api/public/webchat/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ key: KEY }),
    }),
  );
}

function mockCreate() {
  mocks.prismaBase.webchatSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...sessionRow(data.tokenHash as string, { id: data.id, contactId: null }),
  }));
}

function mockRenewUpdate() {
  mocks.prismaBase.webchatSession.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      ...sessionRow(data.tokenHash as string, { contactId: null }),
    }),
  );
}

type UpdateCall = [{ where: Record<string, unknown>; data: Record<string, unknown> }];
const baseUpdates = () => mocks.prismaBase.webchatSession.update.mock.calls as unknown as UpdateCall[];

describe("POST /api/public/webchat/session — rate limit sem atalho", () => {
  it("token autêntico porém substituído (hash velho) cria visitante e gasta do balde do IP", async () => {
    mockCreate();
    const { token } = await visitorToken();
    // A sessão já girou: o hash guardado é outro e a carência não vale.
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow("hash-mais-novo"));
    for (let i = 0; i < 10; i++) {
      const res = await sessionCall(token);
      expect(res.status).toBe(200);
      expect((await res.json()).renewed).toBe(false);
    }
    expect(mocks.prismaBase.webchatSession.create).toHaveBeenCalledTimes(10);
    expect((await sessionCall(token)).status).toBe(429);
    expect(mocks.prismaBase.webchatSession.create).toHaveBeenCalledTimes(10);
  });

  it("renovação legítima gasta do balde do visitante (não do IP) e guarda o token anterior", async () => {
    mockCreate();
    // Esgota o balde de criação do IP.
    for (let i = 0; i < 10; i++) expect((await sessionCall(null)).status).toBe(200);
    expect((await sessionCall(null)).status).toBe(429);

    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash, { contactId: null }));
    mockRenewUpdate();
    const res = await sessionCall(token);
    expect(res.status).toBe(200);
    expect((await res.json()).renewed).toBe(true);
    const update = baseUpdates()[0]![0];
    expect(update.where).toEqual({ id: "wv_v1" });
    expect(update.data).toMatchObject({ prevTokenHash: tokenHash, rotatedAt: expect.any(Date) });
    expect(update.data.tokenHash).not.toBe(tokenHash);
  });

  it("IPv6: endereços do mesmo /64 dividem o balde; outro /64 não", async () => {
    mockCreate();
    for (let i = 0; i < 10; i++) {
      const res = await sessionCall(null, `2001:db8:abcd:12::${(i + 1).toString(16)}`);
      expect(res.status).toBe(200);
    }
    expect((await sessionCall(null, "2001:db8:abcd:12:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await sessionCall(null, "2001:db8:abcd:13::1")).status).toBe(200);
  });

  it("rateLimitIpKey: IPv6 → /64; IPv4 intacto", () => {
    expect(rateLimitIpKey("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(rateLimitIpKey("2001:0db8:abcd:0012:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(rateLimitIpKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("sessão além da vida máxima: não renova, cria visitante novo (balde do IP)", async () => {
    mockCreate();
    process.env.WEBCHAT_SESSION_MAX_AGE_DAYS = "90";
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(
      sessionRow(tokenHash, { createdAt: new Date(Date.now() - 91 * 24 * 3600 * 1000) }),
    );
    const res = await sessionCall(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renewed).toBe(false);
    expect(body.visitorId).not.toBe("wv_v1");
    expect(mocks.prismaBase.webchatSession.update).not.toHaveBeenCalled();
  });
});

// ── Carência do token anterior e vida máxima ───────────────────────

describe("token anterior (carência de 60 s) e vida máxima", () => {
  async function getWith(token: string) {
    return getMessages(
      req("/api/public/webchat/messages", { headers: { authorization: `Bearer ${token}` } }),
    );
  }

  it("token anterior vale até 60 s depois da rotação; depois → 401", async () => {
    mocks.prisma.message.findMany.mockResolvedValue([]);
    const { token: oldToken, tokenHash: oldHash } = await visitorToken(new Date(Date.now() - 2_000));
    const fresh = await signWebchatToken({ org: "org-1", ch: "ch-1", vis: "wv_v1", cid: "ct-1" });
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(
      sessionRow(fresh.tokenHash, { prevTokenHash: oldHash, rotatedAt: new Date(Date.now() - 30_000) }),
    );
    expect((await getWith(oldToken)).status).toBe(200);
    expect((await getWith(fresh.token)).status).toBe(200);

    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(
      sessionRow(fresh.tokenHash, { prevTokenHash: oldHash, rotatedAt: new Date(Date.now() - 61_000) }),
    );
    expect((await getWith(oldToken)).status).toBe(401);
    expect((await getWith(fresh.token)).status).toBe(200);
  });

  it("token de duas rotações atrás não vale nem dentro da carência", async () => {
    const { token: ancient } = await visitorToken(new Date(Date.now() - 5_000));
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(
      sessionRow("hash-atual", { prevTokenHash: "hash-anterior", rotatedAt: new Date() }),
    );
    expect((await getWith(ancient)).status).toBe(401);
  });

  it("sessão além da vida máxima → 401 TOKEN_EXPIRED mesmo com token válido", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(
      sessionRow(tokenHash, { createdAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) }),
    );
    const res = await getWith(token);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("TOKEN_EXPIRED");
  });

  it("renovar com o token anterior (outra aba) gira de novo e o atual vira o anterior", async () => {
    const { token: oldToken, tokenHash: oldHash } = await visitorToken(new Date(Date.now() - 2_000));
    const current = await signWebchatToken({ org: "org-1", ch: "ch-1", vis: "wv_v1", cid: "ct-1" });
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(
      sessionRow(current.tokenHash, {
        contactId: null,
        prevTokenHash: oldHash,
        rotatedAt: new Date(Date.now() - 5_000),
      }),
    );
    mockRenewUpdate();
    const res = await sessionCall(oldToken);
    expect(res.status).toBe(200);
    expect((await res.json()).renewed).toBe(true);
    expect(baseUpdates()[0]![0].data.prevTokenHash).toBe(current.tokenHash);
    expect(hashWebchatToken(current.token)).toBe(current.tokenHash);
  });
});

// ── Teto do corpo ──────────────────────────────────────────────────

describe("teto do corpo nas rotas públicas", () => {
  it("Content-Length acima de 32 KB → 413 antes de autenticar", async () => {
    const res = await postMessage(
      req("/api/public/webchat/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(64 * 1024) },
        body: "{}",
      }),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("PAYLOAD_TOO_LARGE");
    expect(mocks.prismaBase.webchatSession.findUnique).not.toHaveBeenCalled();
  });

  it("corpo sem Content-Length (stream) maior que o teto → 413", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ key: KEY, pad: "x".repeat(40 * 1024) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 8192) controller.enqueue(big.slice(i, i + 8192));
        controller.close();
      },
    });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: stream,
      // Node exige `duplex` para corpo em stream.
      duplex: "half",
    } as RequestInit;
    const res = await postSession(new Request("https://api.bwipo.com/api/public/webchat/session", init));
    expect(res.status).toBe(413);
    expect(mocks.prismaBase.channel.findUnique).not.toHaveBeenCalled();
  });
});

// ── Identify: só dados do próprio visitante ────────────────────────

describe("POST /api/public/webchat/session/identify", () => {
  it("e-mail de outro contato: resposta só com o contato próprio, sem matchedBy nem dados alheios", async () => {
    const { token, tokenHash } = await visitorToken();
    mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(tokenHash));
    const own = { id: "ct-1", name: "Visitante wv_v1", email: "ana@cliente.com", phone: null };
    mocks.prisma.contact.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, unknown> }).where;
      return where.webchatVisitorId === "wv_v1" ? own : null;
    });
    mocks.prisma.contact.findMany.mockResolvedValue([{ id: "ct-ana", name: "Ana Souza", number: 42 }]);
    const res = await postIdentify(
      req("/api/public/webchat/session/identify", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: "ana@cliente.com" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "contact",
      "contactId",
      "expiresAt",
      "merged",
      "token",
      "verified",
    ]);
    expect(body).toMatchObject({ contactId: "ct-1", merged: false, verified: false });
    expect(body.contact).toEqual({
      name: "Visitante wv_v1",
      email: "ana@cliente.com",
      phone: null,
      identified: true,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("ct-ana");
    expect(text).not.toContain("Ana Souza");
    // A sessão nunca é repontada para o contato existente.
    const scoped = mocks.prisma.webchatSession.update.mock.calls as unknown as UpdateCall[];
    for (const call of scoped) expect(call[0].data.contactId).not.toBe("ct-ana");
    // O reissue guarda o token atual como anterior (carência).
    const rotate = baseUpdates().at(-1)![0];
    expect(rotate.data).toMatchObject({ prevTokenHash: expect.any(String), rotatedAt: expect.any(Date) });
  });
});
