/**
 * Webchat v2 — rotas públicas de contexto vivo (`POST /context`) e linha do
 * tempo (`POST /events`): merge e limites, lote, token no corpo (beacon),
 * evento importante → nota, visitante anônimo → contato, isolamento de org
 * e SSE. Tokens reais (jose); banco simulado em memória. Dados neutros.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  const db = { contexts: [] as Row[], events: [] as Row[], seq: 0 };
  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
  const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => same(row[k], v));
  const pick = (row: Row, select?: Row) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
  const liveContext = {
    findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
      const row = db.contexts.find((c) => matches(c, where));
      return row ? pick(row, select) : null;
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `ctx-${++db.seq}`, ...data };
      db.contexts.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = db.contexts.filter((c) => matches(c, where));
      hit.forEach((c) => Object.assign(c, data));
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = db.contexts.find((c) => c.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      db.contexts = db.contexts.filter((c) => c.id !== where.id);
    }),
  };
  const webchatEvent = {
    createManyAndReturn: vi.fn(async ({ data, select }: { data: Row[]; select?: Row }) =>
      data.map((d) => {
        const row = { id: `ev-${++db.seq}`, createdAt: new Date(), ...d };
        db.events.push(row);
        return pick(row, select);
      }),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = db.events.filter((e) => matches(e, where));
      hit.forEach((e) => Object.assign(e, data));
      return { count: hit.length };
    }),
  };
  return {
    logger,
    db,
    prismaBase: {
      channel: { findUnique: vi.fn() },
      webchatSession: {
        findUnique: vi.fn(),
        update: vi.fn(async () => ({})),
      },
    },
    prisma: { webchatLiveContext: liveContext, webchatEvent },
    publishWebchatContext: vi.fn(),
    publishWebchatEvent: vi.fn(),
    findActiveWebchatConversation: vi.fn(async (): Promise<{ id: string; number: number } | null> => null),
    createWebchatSiteNote: vi.fn(async () => "msg-1"),
    findOrCreateWebchatConversation: vi.fn(async () => ({ id: "conv-new", assignedToId: null, created: true })),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: mocks.prismaBase }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/cache/keys", () => ({
  wrapChannelLookup: (_k: string, _t: number, loader: () => Promise<unknown>) => loader(),
}));
vi.mock("@/lib/realtime-events", () => ({
  publishWebchatContext: mocks.publishWebchatContext,
  publishWebchatEvent: mocks.publishWebchatEvent,
}));
vi.mock("@/lib/webchat/conversation-notes", () => ({
  findActiveWebchatConversation: mocks.findActiveWebchatConversation,
  createWebchatSiteNote: mocks.createWebchatSiteNote,
}));
vi.mock("@/lib/webchat/inbound", () => ({
  findOrCreateWebchatConversation: mocks.findOrCreateWebchatConversation,
}));

import { POST as postContext } from "@/app/api/public/webchat/context/route";
import { POST as postEvents } from "@/app/api/public/webchat/events/route";
import { getRequestContext } from "@/lib/request-context";
import { resetRateLimitersForTests } from "@/lib/rate-limit";
import { adoptAnonymousVisitorData } from "@/lib/webchat/visitor-data";
import { signWebchatToken } from "@/lib/webchat/token";

const KEY = "wc_ABCDEFGHIJKLMNOPQRSTUVWX";
const ORIGIN = "https://www.site-exemplo.test";

function channelRow(v2: Record<string, unknown> = {}) {
  return {
    id: "ch-1",
    organizationId: "org-1",
    name: "Site",
    publicKey: KEY,
    provider: "WEBCHAT",
    status: "CONNECTED",
    defaultPipelineId: null,
    config: { allowedOrigins: [ORIGIN], v2 },
    organization: { status: "ACTIVE", primaryColor: null, logoUrl: null },
  };
}

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
    identityVerifiedAt: new Date(),
    ...over,
  };
}

async function visitor(over: Record<string, unknown> = {}, claims: { org?: string; cid?: string | null } = {}) {
  const signed = await signWebchatToken({
    org: claims.org ?? "org-1",
    ch: "ch-1",
    vis: "wv_v1",
    cid: claims.cid === undefined ? "ct-1" : claims.cid,
  });
  mocks.prismaBase.webchatSession.findUnique.mockResolvedValue(sessionRow(signed.tokenHash, over));
  return signed.token;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.bwipo.com${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "x-forwarded-for": "203.0.113.7",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitersForTests();
  mocks.db.contexts = [];
  mocks.db.events = [];
  process.env.AUTH_SECRET = "test-auth-secret-for-webchat-tracking";
  process.env.TENANT_BASE_DOMAIN = "bwipo.com";
  mocks.prismaBase.channel.findUnique.mockResolvedValue(channelRow());
  mocks.findActiveWebchatConversation.mockResolvedValue(null);
});

describe("POST /api/public/webchat/context", () => {
  it("merge raso: atualiza, remove com null e não mexe no resto", async () => {
    const token = await visitor();
    const r1 = await postContext(post("/api/public/webchat/context", { context: { etapa: "1", secao: "a" } }, auth(token)));
    expect(r1.status).toBe(200);
    const r2 = await postContext(post("/api/public/webchat/context", { context: { etapa: "2", secao: null, progresso: 40 } }, auth(token)));
    const body = await r2.json();
    expect(body).toMatchObject({ ok: true, ignored: [] });
    expect(mocks.db.contexts).toHaveLength(1);
    expect(mocks.db.contexts[0]).toMatchObject({
      organizationId: "org-1",
      channelId: "ch-1",
      contactId: "ct-1",
      sessionId: null,
      state: { etapa: "2", progresso: 40 },
    });
  });

  it("limites do canal: chave nova além de maxKeys e chave inválida são ignoradas; valor cortado", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue(channelRow({ context: { maxKeys: 2, maxValueChars: 4 } }));
    const token = await visitor();
    const res = await postContext(
      post(
        "/api/public/webchat/context",
        { context: { a: "123456", b: true, c: 3, "x y": 1, d: { obj: 1 } } },
        auth(token),
      ),
    );
    const body = await res.json();
    expect(body.ignored.sort()).toEqual(["c", "d", "x y"]);
    expect(mocks.db.contexts[0]?.state).toEqual({ a: "1234", b: true });
  });

  it("envio idêntico não muda updatedAt nem publica SSE", async () => {
    const token = await visitor();
    const first = await (await postContext(post("/api/public/webchat/context", { context: { etapa: "1" } }, auth(token)))).json();
    expect(mocks.publishWebchatContext).toHaveBeenCalledTimes(1);
    const again = await (await postContext(post("/api/public/webchat/context", { context: { etapa: "1" } }, auth(token)))).json();
    expect(again.updatedAt).toBe(first.updatedAt);
    expect(mocks.publishWebchatContext).toHaveBeenCalledTimes(1);
  });

  it("SSE webchat_context é só sinal: org, contato, canal e updatedAt — sem o estado", async () => {
    const token = await visitor();
    await postContext(post("/api/public/webchat/context", { context: { etapa: "1" } }, auth(token)));
    expect(mocks.publishWebchatContext).toHaveBeenCalledWith({
      organizationId: "org-1",
      contactId: "ct-1",
      channelId: "ch-1",
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(mocks.publishWebchatContext.mock.calls)).not.toContain("etapa");
  });

  it("sem identify assinado e canal sem anonymous → 403 TRACKING_DISABLED, nada gravado", async () => {
    const token = await visitor({ identityVerifiedAt: null });
    const res = await postContext(post("/api/public/webchat/context", { context: { etapa: "1" } }, auth(token)));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TRACKING_DISABLED");
    expect(mocks.db.contexts).toHaveLength(0);
  });

  it("corpo sem `context` objeto → 400 INVALID_BODY", async () => {
    const token = await visitor();
    const res = await postContext(post("/api/public/webchat/context", { context: [1] }, auth(token)));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BODY");
  });

  it("corpo acima de 32 KB → 413", async () => {
    const token = await visitor();
    const res = await postContext(
      post("/api/public/webchat/context", { context: { a: "x".repeat(40_000) } }, auth(token)),
    );
    expect(res.status).toBe(413);
  });

  it("rate limit por visitante (30/min) → 429", async () => {
    const token = await visitor();
    let last = 200;
    for (let i = 0; i < 31; i++) {
      last = (await postContext(post("/api/public/webchat/context", { context: { i } }, auth(token)))).status;
    }
    expect(last).toBe(429);
  });
});

describe("visitante anônimo (config.v2.context.anonymous)", () => {
  it("grava no visitante (sessionId) sem SSE e passa para o contato no identify", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue(channelRow({ context: { anonymous: true } }));
    const token = await visitor({ identityVerifiedAt: null, contactId: null }, { cid: null });
    const ctx = await postContext(post("/api/public/webchat/context", { context: { etapa: "3" } }, auth(token)));
    expect(ctx.status).toBe(200);
    const ev = await postEvents(post("/api/public/webchat/events", { events: [{ name: "abriu_pagina" }] }, auth(token)));
    expect((await ev.json()).accepted).toBe(1);

    expect(mocks.db.contexts[0]).toMatchObject({ sessionId: "wv_v1", contactId: null });
    expect(mocks.db.events[0]).toMatchObject({ sessionId: "wv_v1", contactId: null });
    expect(mocks.publishWebchatContext).not.toHaveBeenCalled();
    expect(mocks.publishWebchatEvent).not.toHaveBeenCalled();

    // identify (frente A) chama o helper da base: tudo passa para o contato.
    await adoptAnonymousVisitorData(mocks.prisma as never, { sessionId: "wv_v1", contactId: "ct-9" });
    expect(mocks.db.contexts[0]).toMatchObject({ sessionId: null, contactId: "ct-9", state: { etapa: "3" } });
    expect(mocks.db.events[0]).toMatchObject({ sessionId: null, contactId: "ct-9" });
  });
});

describe("POST /api/public/webchat/events", () => {
  it("lote: grava os válidos, ignora os inválidos com motivo", async () => {
    const token = await visitor();
    const res = await postEvents(
      post(
        "/api/public/webchat/events",
        { events: [{ name: "passo_concluido", data: { etapa: 2 } }, { name: "" }, { name: "ok", data: { x: [1] } }] },
        auth(token),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      accepted: 1,
      ignored: [
        { index: 1, reason: "INVALID_NAME" },
        { index: 2, reason: "INVALID_DATA" },
      ],
    });
    expect(mocks.db.events[0]).toMatchObject({
      organizationId: "org-1",
      channelId: "ch-1",
      contactId: "ct-1",
      sessionId: null,
      name: "passo_concluido",
      data: { etapa: 2 },
      important: false,
    });
    // SSE é só sinal (um por lote): sem nome nem dados do evento.
    expect(mocks.publishWebchatEvent).toHaveBeenCalledTimes(1);
    expect(mocks.publishWebchatEvent).toHaveBeenCalledWith({
      organizationId: "org-1",
      contactId: "ct-1",
      channelId: "ch-1",
      count: 1,
      latestOccurredAt: expect.any(String),
    });
    const sent = JSON.stringify(mocks.publishWebchatEvent.mock.calls);
    expect(sent).not.toContain("passo_concluido");
    expect(sent).not.toContain("etapa");
  });

  it("lote acima de maxPerBatch → 400 TOO_MANY_EVENTS", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue(channelRow({ events: { maxPerBatch: 2 } }));
    const token = await visitor();
    const res = await postEvents(
      post("/api/public/webchat/events", { events: [{ name: "a" }, { name: "b" }, { name: "c" }] }, auth(token)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_EVENTS");
    expect(mocks.db.events).toHaveLength(0);
  });

  it("sendBeacon: token no corpo, text/plain, sem Authorization", async () => {
    const token = await visitor();
    const res = await postEvents(
      post("/api/public/webchat/events", JSON.stringify({ token, events: [{ name: "saiu_da_pagina" }] }), {
        "content-type": "text/plain;charset=UTF-8",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(1);
  });

  it("token do corpo inválido → 401; sem token nenhum → 401 TOKEN_MISSING", async () => {
    await visitor();
    const bad = await postEvents(post("/api/public/webchat/events", { token: "x.y.z", events: [] }));
    expect(bad.status).toBe(401);
    const none = await postEvents(post("/api/public/webchat/events", { events: [] }));
    expect(none.status).toBe(401);
    expect((await none.json()).code).toBe("TOKEN_MISSING");
  });

  it("evento importante (flag do site) vira nota na conversa ativa", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue(channelRow({ context: { labels: { etapa: "Etapa" } } }));
    mocks.findActiveWebchatConversation.mockResolvedValue({ id: "conv-1", number: 7 });
    const token = await visitor();
    await postEvents(
      post(
        "/api/public/webchat/events",
        { events: [{ name: "pediu_ajuda", data: { etapa: 2 }, important: true }, { name: "rolou" }] },
        auth(token),
      ),
    );
    expect(mocks.createWebchatSiteNote).toHaveBeenCalledTimes(1);
    expect(mocks.createWebchatSiteNote).toHaveBeenCalledWith({
      organizationId: "org-1",
      conversationId: "conv-1",
      contactId: "ct-1",
      content: "📍 Evento no site · Pediu ajuda\nEtapa: 2",
    });
    expect(mocks.db.events.map((e) => e.important)).toEqual([true, false]);
  });

  it("evento importante pela config do canal; sem conversa só abre se importantOpensConversation", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue(channelRow({ events: { important: ["pediu_ajuda"] } }));
    const token = await visitor();
    await postEvents(post("/api/public/webchat/events", { events: [{ name: "pediu_ajuda" }] }, auth(token)));
    expect(mocks.findOrCreateWebchatConversation).not.toHaveBeenCalled();
    expect(mocks.createWebchatSiteNote).not.toHaveBeenCalled();
    expect(mocks.db.events[0]?.important).toBe(true);

    mocks.prismaBase.channel.findUnique.mockResolvedValue(
      channelRow({ events: { important: ["pediu_ajuda"], importantOpensConversation: true } }),
    );
    await postEvents(post("/api/public/webchat/events", { events: [{ name: "pediu_ajuda" }] }, auth(token)));
    expect(mocks.findOrCreateWebchatConversation).toHaveBeenCalledWith("ct-1", "ch-1");
    expect(mocks.createWebchatSiteNote).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-new", content: "📍 Evento no site · Pediu ajuda" }),
    );
  });

  it("a nota roda no contexto de org do canal", async () => {
    mocks.findActiveWebchatConversation.mockImplementation(async () => {
      expect(getRequestContext()?.organizationId).toBe("org-1");
      return { id: "conv-1", number: 1 };
    });
    const token = await visitor();
    await postEvents(post("/api/public/webchat/events", { events: [{ name: "x", important: true }] }, auth(token)));
    expect(mocks.createWebchatSiteNote).toHaveBeenCalledTimes(1);
  });
});

describe("isolamento de org", () => {
  it("token de uma org apontando para sessão de outra → 401, nada gravado", async () => {
    const token = await visitor({ organizationId: "org-2" });
    const ctx = await postContext(post("/api/public/webchat/context", { context: { etapa: "1" } }, auth(token)));
    expect(ctx.status).toBe(401);
    const ev = await postEvents(post("/api/public/webchat/events", { token, events: [{ name: "a" }] }));
    expect(ev.status).toBe(401);
    expect(mocks.db.contexts).toHaveLength(0);
    expect(mocks.db.events).toHaveLength(0);
  });

  it("canal de outra org que a sessão → 404, nada gravado", async () => {
    mocks.prismaBase.channel.findUnique.mockResolvedValue({ ...channelRow(), organizationId: "org-2" });
    const token = await visitor();
    const res = await postContext(post("/api/public/webchat/context", { context: { etapa: "1" } }, auth(token)));
    expect(res.status).toBe(404);
    expect(mocks.db.contexts).toHaveLength(0);
  });

  it("origem fora de allowedOrigins → 403", async () => {
    const token = await visitor();
    const res = await postEvents(
      post("/api/public/webchat/events", { events: [{ name: "a" }] }, { ...auth(token), origin: "https://outro.test" }),
    );
    expect(res.status).toBe(403);
  });
});
