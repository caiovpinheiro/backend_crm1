/**
 * Identificação do visitante: cruzamento por e-mail/telefone e merge no
 * contato existente (o existente sobrevive). Prisma e merge mockados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  const prisma = {
    contact: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
    conversation: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
    message: { updateMany: vi.fn(async () => ({ count: 2 })) },
    deal: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    webchatSession: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return {
    logger,
    prisma,
    mergeContacts: vi.fn(),
    link: vi.fn(async () => ({})),
    ensureVisitorContact: vi.fn(),
    publishContactUpdated: vi.fn(),
    publishConversationUpdated: vi.fn(),
    invalidateBoards: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageChange: vi.fn(async () => {}) }));
vi.mock("@/lib/realtime-events", () => ({
  publishContactUpdated: mocks.publishContactUpdated,
  publishConversationUpdated: mocks.publishConversationUpdated,
}));
vi.mock("@/lib/webchat/inbound", () => ({
  WEBCHAT_CONVERSATION_CHANNEL: "webchat",
  ensureVisitorContact: mocks.ensureVisitorContact,
  anonymousVisitorName: (id: string) => `Visitante ${id.slice(-6)}`,
}));
vi.mock("@/lib/cache/keys", () => ({ invalidateBoardData: mocks.invalidateBoards }));
vi.mock("@/services/conversations", () => ({ linkContactToConversation: mocks.link }));
vi.mock("@/services/merge-contacts", () => ({ mergeContacts: mocks.mergeContacts }));

import {
  WebchatIdentifyError,
  identifyWebchatVisitor,
  parseWebchatIdentity,
  renameAnonymousVisitorDeals,
} from "@/lib/webchat/identify";
import type { WebchatSessionRow } from "@/lib/webchat/session";

function session(contactId: string | null): WebchatSessionRow {
  return {
    id: "wv_visitor_1",
    organizationId: "org-1",
    channelId: "ch-1",
    contactId,
    tokenHash: "h",
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    firstUrl: null,
    lastUrl: null,
    referrer: null,
    utm: null,
  };
}

const EXISTING = {
  id: "ct-old",
  name: "Ana Souza",
  email: "ana@cliente.com",
  phone: null,
  webchatVisitorId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mocks.prisma));
  mocks.prisma.contact.findFirst.mockResolvedValue(null);
  mocks.prisma.conversation.findFirst.mockResolvedValue(null);
  mocks.mergeContacts.mockResolvedValue({ ok: true, result: {} });
  mocks.prisma.deal.findMany.mockResolvedValue([]);
});

// session.id "wv_visitor_1" → placeholder "Visitante itor_1"
const PLACEHOLDER = "Negócio Visitante itor_1";

describe("renameAnonymousVisitorDeals", () => {
  it("renomeia o deal aberto que ainda tem o título do visitante anônimo", async () => {
    mocks.prisma.deal.findMany.mockResolvedValue([{ id: "d1", stage: { pipelineId: "p1" } }]);
    const n = await renameAnonymousVisitorDeals("org-1", "ct-1", "wv_visitor_1", "Ana Souza");
    expect(n).toBe(1);
    expect(mocks.prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "ct-1", status: "OPEN", title: PLACEHOLDER } }),
    );
    expect(mocks.prisma.deal.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["d1"] }, title: PLACEHOLDER },
      data: { title: "Negócio Ana Souza" },
    });
    expect(mocks.invalidateBoards).toHaveBeenCalledWith("org-1", "p1");
  });

  it("título editado pelo operador não casa com o placeholder: nada muda", async () => {
    // a busca é pelo título exato — deal "Matrícula Ana" não volta
    mocks.prisma.deal.findMany.mockResolvedValue([]);
    const n = await renameAnonymousVisitorDeals("org-1", "ct-1", "wv_visitor_1", "Ana Souza");
    expect(n).toBe(0);
    expect(mocks.prisma.deal.updateMany).not.toHaveBeenCalled();
  });

  it("sem nome real (vazio/placeholder) não consulta nem renomeia", async () => {
    expect(await renameAnonymousVisitorDeals("org-1", "ct-1", "wv_visitor_1", null)).toBe(0);
    expect(await renameAnonymousVisitorDeals("org-1", "ct-1", "wv_visitor_1", "Visitante itor_1")).toBe(0);
    expect(mocks.prisma.deal.findMany).not.toHaveBeenCalled();
  });
});

describe("parseWebchatIdentity", () => {
  it("normaliza e-mail e telefone; rejeita inválidos", () => {
    expect(parseWebchatIdentity({ name: " Ana ", email: "ANA@X.COM", phone: "(11) 98765-4321" })).toEqual({
      name: "Ana",
      email: "ana@x.com",
      phone: "+5511987654321",
    });
    expect(() => parseWebchatIdentity({ email: "nao-e-email" })).toThrow(WebchatIdentifyError);
    expect(() => parseWebchatIdentity({ phone: "abc" })).toThrow(WebchatIdentifyError);
  });
});

describe("identifyWebchatVisitor", () => {
  it("sem contato correspondente: o contato anônimo recebe os dados (sem merge)", async () => {
    const s = session("ct-anon");
    mocks.prisma.conversation.findFirst.mockResolvedValue({ id: "conv-anon", unreadCount: 1 });
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Bruno", email: "bruno@x.com", phone: null },
    });
    expect(res).toEqual({ contactId: "ct-anon", merged: false, matchedBy: null });
    expect(mocks.prisma.contact.update).toHaveBeenCalledWith({
      where: { id: "ct-anon" },
      data: { name: "Bruno", email: "bruno@x.com" },
    });
    expect(mocks.mergeContacts).not.toHaveBeenCalled();
    expect(mocks.prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "ct-anon", status: "OPEN", title: PLACEHOLDER } }),
    );
    expect(mocks.publishContactUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "ct-anon" }),
    );
    expect(mocks.publishConversationUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-anon", contactId: "ct-anon" }),
    );
  });

  it("visitante ainda sem contato e sem correspondência: cria o contato com os dados", async () => {
    const s = session(null);
    mocks.ensureVisitorContact.mockResolvedValue({ id: "ct-new", name: "Carla", isNew: true });
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Carla", email: null, phone: "+5511999998888" },
    });
    expect(res).toEqual({ contactId: "ct-new", merged: false, matchedBy: null });
    expect(mocks.ensureVisitorContact).toHaveBeenCalledWith(s, expect.objectContaining({ name: "Carla" }));
  });

  it("e-mail casa com contato existente: anônimo é fundido nele e o ticket é religado", async () => {
    const s = session("ct-anon");
    mocks.prisma.contact.findFirst.mockResolvedValueOnce(EXISTING);
    mocks.prisma.conversation.findFirst
      .mockResolvedValueOnce({ id: "conv-anon", unreadCount: 2 }) // anônimo
      .mockResolvedValueOnce(null); // existente sem ticket webchat aberto
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: null, email: "ana@cliente.com", phone: "+5511987654321" },
    });
    expect(res).toEqual({ contactId: "ct-old", merged: true, matchedBy: "email" });
    expect(mocks.prisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "ct-anon" },
          email: { equals: "ana@cliente.com", mode: "insensitive" },
        }),
      }),
    );
    expect(mocks.link).toHaveBeenCalledWith("conv-anon", "ct-old");
    expect(mocks.prisma.webchatSession.updateMany).toHaveBeenCalledWith({
      where: { contactId: "ct-anon" },
      data: { contactId: "ct-old" },
    });
    expect(mocks.prisma.contact.update).toHaveBeenCalledWith({
      where: { id: "ct-anon" },
      data: { webchatVisitorId: null },
    });
    expect(mocks.mergeContacts).toHaveBeenCalledWith("ct-old", "ct-anon");
    expect(mocks.prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: "ct-old", status: "OPEN", title: PLACEHOLDER } }),
    );
    // existente sobrevive: ganha telefone (vazio) e o visitorId; nome não muda
    expect(mocks.prisma.contact.update).toHaveBeenLastCalledWith({
      where: { id: "ct-old" },
      data: { phone: "+5511987654321", webchatVisitorId: s.id },
    });
    expect(s.contactId).toBe("ct-old");
    expect(mocks.publishContactUpdated).toHaveBeenCalledWith(expect.objectContaining({ contactId: "ct-old" }));
    expect(mocks.publishConversationUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-anon", contactId: "ct-old" }),
    );
  });

  it("existente já tem ticket webchat aberto: mensagens do anônimo migram para ele", async () => {
    const s = session("ct-anon");
    mocks.prisma.contact.findFirst
      .mockResolvedValueOnce(null) // e-mail
      .mockResolvedValueOnce({ ...EXISTING, phone: "+5511987654321" }); // telefone
    mocks.prisma.conversation.findFirst
      .mockResolvedValueOnce({ id: "conv-anon", unreadCount: 3 })
      .mockResolvedValueOnce({ id: "conv-old", unreadCount: 0 });
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: null, email: "outro@x.com", phone: "+551187654321" },
    });
    expect(res).toEqual({ contactId: "ct-old", merged: true, matchedBy: "phone" });
    expect(mocks.prisma.message.updateMany).toHaveBeenCalledWith({
      where: { conversationId: "conv-anon" },
      data: { conversationId: "conv-old" },
    });
    expect(mocks.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conv-anon" },
        data: expect.objectContaining({ status: "RESOLVED" }),
      }),
    );
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.mergeContacts).toHaveBeenCalledWith("ct-old", "ct-anon");
    expect(mocks.publishConversationUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "conv-old", contactId: "ct-old" }),
    );
  });

  it("visitante sem contato casa com existente: liga direto, sem merge de contato", async () => {
    const s = session(null);
    mocks.prisma.contact.findFirst.mockResolvedValueOnce(EXISTING);
    const res = await identifyWebchatVisitor({
      organizationId: "org-1",
      session: s,
      identity: { name: "Ana", email: "ana@cliente.com", phone: null },
    });
    expect(res).toEqual({ contactId: "ct-old", merged: true, matchedBy: "email" });
    expect(mocks.prisma.webchatSession.update).toHaveBeenCalledWith({
      where: { id: s.id },
      data: { contactId: "ct-old" },
    });
    expect(mocks.mergeContacts).not.toHaveBeenCalled();
  });

  it("sem nenhum dado → erro de validação", async () => {
    await expect(
      identifyWebchatVisitor({
        organizationId: "org-1",
        session: session(null),
        identity: { name: null, email: null, phone: null },
      }),
    ).rejects.toBeInstanceOf(WebchatIdentifyError);
  });
});
