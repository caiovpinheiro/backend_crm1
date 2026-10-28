/**
 * Painel "No site agora": loader (último estado + eventos recentes + rótulos)
 * e a rota `GET /api/conversations/:id/webchat-context` (acesso da conversa).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    prisma: {
      channel: { findFirst: vi.fn() },
      webchatLiveContext: { findFirst: vi.fn() },
      webchatEvent: { findMany: vi.fn() },
      conversation: { findFirst: vi.fn() },
    },
    access: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: async () => ({ ok: true, user: { id: "u1", role: "AGENT", organizationId: "org-1" } }),
  runWithApiUserContext: (_u: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/conversation-access", () => ({
  CONVERSATION_ACCESS_SELECT: { id: true, assignedToId: true, channelId: true, contactId: true, organizationId: true },
  requireConversationAccessAndLoad: mocks.access,
}));

import { GET } from "@/app/api/conversations/[id]/webchat-context/route";
import { loadWebchatSitePanel } from "@/lib/webchat/tracking/panel";
import { WEBCHAT_RECENT_EVENTS } from "@/lib/webchat/v2-config";

const CONV = { channel: "webchat", channelId: "ch-1", contactId: "ct-1" };
const T = new Date("2026-10-28T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.channel.findFirst.mockResolvedValue({
    provider: "WEBCHAT",
    config: { v2: { context: { labels: { etapa: "Etapa atual" } } } },
  });
  mocks.prisma.webchatLiveContext.findFirst.mockResolvedValue({
    state: { etapa: "2", progresso: 40, "chave inválida": 1, obj: { x: 1 } },
    updatedAt: T,
  });
  mocks.prisma.webchatEvent.findMany.mockResolvedValue([
    { id: "e2", name: "passo_concluido", data: { etapa: 2 }, important: true, occurredAt: T },
    { id: "e1", name: "abriu", data: null, important: false, occurredAt: new Date(T.getTime() - 60_000) },
  ]);
});

describe("loadWebchatSitePanel", () => {
  it("último estado (só valores simples), rótulos do canal e eventos recentes", async () => {
    const panel = await loadWebchatSitePanel(CONV);
    expect(panel).toEqual({
      available: true,
      contactId: "ct-1",
      channelId: "ch-1",
      labels: { etapa: "Etapa atual" },
      context: { state: { etapa: "2", progresso: 40 }, updatedAt: T.toISOString() },
      events: [
        { id: "e2", name: "passo_concluido", data: { etapa: 2 }, important: true, occurredAt: T.toISOString() },
        { id: "e1", name: "abriu", data: null, important: false, occurredAt: "2026-10-28T11:59:00.000Z" },
      ],
    });
  });

  it("lê só pelo contato+canal da conversa, os N mais recentes (sem reprocessar)", async () => {
    await loadWebchatSitePanel(CONV);
    expect(mocks.prisma.webchatLiveContext.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channelId: "ch-1", contactId: "ct-1" } }),
    );
    expect(mocks.prisma.webchatEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId: "ct-1", channelId: "ch-1" },
        take: WEBCHAT_RECENT_EVENTS,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("sem contexto ainda: context null", async () => {
    mocks.prisma.webchatLiveContext.findFirst.mockResolvedValue(null);
    mocks.prisma.webchatEvent.findMany.mockResolvedValue([]);
    const panel = await loadWebchatSitePanel(CONV);
    expect(panel).toMatchObject({ available: true, context: null, events: [] });
  });

  it("conversa fora do webchat ou sem contato → indisponível, sem consultar", async () => {
    expect((await loadWebchatSitePanel({ ...CONV, channel: "whatsapp" })).available).toBe(false);
    expect((await loadWebchatSitePanel({ ...CONV, contactId: null })).available).toBe(false);
    expect(mocks.prisma.webchatEvent.findMany).not.toHaveBeenCalled();
  });

  it("canal que não é WEBCHAT → indisponível", async () => {
    mocks.prisma.channel.findFirst.mockResolvedValue({ provider: "META", config: {} });
    expect((await loadWebchatSitePanel(CONV)).available).toBe(false);
  });
});

describe("GET /api/conversations/:id/webchat-context", () => {
  const call = (id: string) =>
    GET(new Request(`https://api.bwipo.com/api/conversations/${id}/webchat-context`), {
      params: Promise.resolve({ id }),
    });

  it("sem acesso à conversa (outra org, canal ou departamento) → 404 e nada lido", async () => {
    mocks.access.mockResolvedValue({
      response: new Response(JSON.stringify({ message: "Conversa não encontrada ou sem permissão." }), {
        status: 404,
      }),
    });
    const res = await call("conv-de-outra-org");
    expect(res.status).toBe(404);
    expect(mocks.prisma.webchatLiveContext.findFirst).not.toHaveBeenCalled();
    expect(mocks.prisma.webchatEvent.findMany).not.toHaveBeenCalled();
  });

  it("com acesso → painel", async () => {
    mocks.access.mockResolvedValue({
      conversation: { id: "conv-1", organizationId: "org-1", assignedToId: null, ...CONV },
    });
    const res = await call("conv-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ available: true, contactId: "ct-1", labels: { etapa: "Etapa atual" } });
    expect(mocks.access.mock.calls[0]?.[1]).toBe("conv-1");
  });
});
