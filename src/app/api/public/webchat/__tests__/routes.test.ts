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
      webchatSession: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
      systemUsageSession: { findFirst: vi.fn(async () => null) },
    },
    prisma: {
      message: {
        findMany: vi.fn(),
        findFirst: vi.fn(async (): Promise<unknown> => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      conversation: { findFirst: vi.fn(async (): Promise<unknown> => null) },
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
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    firstUrl: null,
    lastUrl: null,
    referrer: null,
    utm: null,
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
