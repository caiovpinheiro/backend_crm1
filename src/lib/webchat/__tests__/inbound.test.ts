/**
 * Inbound do webchat: pipeline igual ao Messenger/Instagram e idempotência
 * por `clientMessageId`. Prisma e efeitos mockados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    insertContact: vi.fn(),
    publishNewMessage: vi.fn(),
    fireTrigger: vi.fn(async () => {}),
    ensureDeal: vi.fn(async () => {}),
    onAi: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    touchInbound: vi.fn(async () => {}),
    emitConversationCreated: vi.fn(),
    noteDuplicates: vi.fn(async () => {}),
    dedup: { lose: false },
    prisma: {
      message: { findFirst: vi.fn(), create: vi.fn() },
      contact: { findUnique: vi.fn(), findFirst: vi.fn() },
      conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async () => ({})) },
      webchatSession: {
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
      },
    },
    recordRef: vi.fn(async () => ({ id: "ref-1", created: true })),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/message-dedup", () => ({
  createMessageDedup: async (fn: () => Promise<unknown>) => (mocks.dedup.lose ? null : fn()),
}));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageRowChange: vi.fn(async () => {}) }));
vi.mock("@/lib/realtime-events", () => ({ publishNewMessage: mocks.publishNewMessage }));
vi.mock("@/lib/web-push", () => ({ notifyInboundMessage: mocks.push }));
vi.mock("@/lib/conversation-inbound", () => ({
  touchInbound: mocks.touchInbound,
  warnTouchInboundFailed: vi.fn(),
}));
vi.mock("@/services/ai/turn-manager", () => ({ onInboundMessageForAi: mocks.onAi }));
vi.mock("@/lib/webchat/conversation-ref", () => ({
  recordWebchatConversationRef: mocks.recordRef,
}));
vi.mock("@/lib/webchat/duplicate-notice", () => ({
  notePossibleDuplicatesInConversation: mocks.noteDuplicates,
}));
vi.mock("@/services/ai/attendance-gate", () => ({
  inheritContactAssigneeForNewTicket: async () => null,
}));
vi.mock("@/services/auto-deals", () => ({ ensureOpenDealForContact: mocks.ensureDeal }));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: mocks.fireTrigger,
  buildMessageTriggerData: (d: unknown) => d,
  emitConversationCreated: mocks.emitConversationCreated,
  openingMessageTriggerExtra: () => ({}),
}));
vi.mock("@/services/contacts", () => ({
  insertContactWithNextNumber: mocks.insertContact,
  isPrismaUniqueViolation: () => false,
}));
vi.mock("@/services/conversations", () => ({
  activeConversationOnAccountWhere: (a: unknown) => a,
  isActiveConversationUniqueViolation: () => false,
  withConversationNumberRetry: (fn: (n: number) => Promise<unknown>) => fn(1),
}));
vi.mock("@/services/distribution", () => ({
  maybeDistributeNewInboundTicket: vi.fn(async () => {}),
}));

import { processWebchatInbound, webchatExternalId } from "@/lib/webchat/inbound";
import type { WebchatSessionRow } from "@/lib/webchat/session";

function session(over: Partial<WebchatSessionRow> = {}): WebchatSessionRow {
  return {
    id: "wv_visitor00000000abc123",
    organizationId: "org-1",
    channelId: "ch-1",
    contactId: null,
    tokenHash: "h",
    prevTokenHash: null,
    rotatedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    firstUrl: "https://site.test/landing",
    lastUrl: null,
    referrer: "https://google.com/",
    utm: { utm_source: "google", gclid: "g-1" },
    createdAt: new Date(),
    ...over,
  };
}

const NOW = new Date("2026-10-17T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dedup.lose = false;
  mocks.prisma.message.findFirst.mockResolvedValue(null);
  mocks.prisma.contact.findUnique.mockResolvedValue(null);
  mocks.prisma.contact.findFirst.mockResolvedValue(null);
  mocks.prisma.conversation.findFirst.mockResolvedValue(null);
  mocks.prisma.webchatSession.findFirst.mockResolvedValue(null);
  mocks.prisma.conversation.create.mockResolvedValue({ id: "conv-1", assignedToId: null });
  mocks.insertContact.mockResolvedValue({ id: "ct-1", name: "Visitante abc123" });
  mocks.prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "msg-1",
    organizationId: "org-1",
    externalId: data.externalId,
    conversationId: data.conversationId,
    content: data.content,
    createdAt: data.createdAt,
  }));
});

describe("processWebchatInbound", () => {
  it("visitante novo: cria contato anônimo, ticket webchat e mensagem com os efeitos do inbound + turno de IA", async () => {
    const s = session();
    const res = await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Olá, quero saber do curso",
      now: NOW,
    });

    expect(res.duplicate).toBe(false);
    expect(res).toMatchObject({ conversationId: "conv-1", contactId: "ct-1" });
    expect(mocks.insertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Visitante abc123",
        webchatVisitorId: s.id,
        source: "Webchat",
        lifecycleStage: "LEAD",
        adUtmSource: "google",
        gclid: "g-1",
        referrer: "https://google.com/",
      }),
      expect.anything(),
    );
    expect(mocks.prisma.webchatSession.update).toHaveBeenCalledWith({
      where: { id: s.id },
      data: { contactId: "ct-1" },
    });
    expect(s.contactId).toBe("ct-1");
    expect(mocks.fireTrigger).toHaveBeenCalledWith("contact_created", expect.anything());
    expect(mocks.ensureDeal).toHaveBeenCalledWith(
      expect.objectContaining({ source: "auto_webchat", channelId: "ch-1", contactId: "ct-1" }),
    );
    expect(mocks.prisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channel: "webchat", channelId: "ch-1", status: "OPEN" }),
      }),
    );
    expect(mocks.prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: "in",
          messageType: "text",
          externalId: webchatExternalId(s.id, "c1"),
          channelId: "ch-1",
        }),
      }),
    );
    expect(mocks.touchInbound).toHaveBeenCalledWith({ conversationId: "conv-1", at: NOW });
    expect(mocks.publishNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", conversationId: "conv-1", direction: "in" }),
    );
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ channel: "Webchat" }));
    expect(mocks.fireTrigger).toHaveBeenCalledWith("message_received", expect.anything());
    // Turno de IA aberto com o canal webchat (a resposta sai pelo widget).
    expect(mocks.onAi).toHaveBeenCalledWith({
      conversationId: "conv-1",
      contactId: "ct-1",
      messageId: "msg-1",
      userMessage: "Olá, quero saber do curso",
      channel: "webchat",
    });
    expect(mocks.recordRef).not.toHaveBeenCalled();
  });

  it("ticket novo de visitante já identificado: confere possível duplicado no ticket", async () => {
    const s = session({ contactId: "ct-1" });
    mocks.prisma.contact.findFirst.mockResolvedValueOnce({ id: "ct-1", name: "Ana" });
    mocks.prisma.contact.findUnique.mockResolvedValue({ id: "ct-1", email: "ana@x.com", phone: null });
    await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Oi",
    });
    await vi.waitFor(() =>
      expect(mocks.noteDuplicates).toHaveBeenCalledWith({
        organizationId: "org-1",
        conversationId: "conv-1",
        contact: { id: "ct-1", email: "ana@x.com", phone: null },
      }),
    );
  });

  it("sessão apontando para contato que não nasceu nela: cria o contato próprio e repontua", async () => {
    const s = session({ contactId: "ct-alheio" });
    // posse ({ id, webchatVisitorId }) e busca por visitorId: nada
    mocks.prisma.contact.findFirst.mockResolvedValue(null);
    await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Oi",
    });
    expect(mocks.prisma.contact.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: "ct-alheio", webchatVisitorId: s.id } }),
    );
    expect(mocks.insertContact).toHaveBeenCalledWith(
      expect.objectContaining({ webchatVisitorId: s.id }),
      expect.anything(),
    );
    expect(s.contactId).toBe("ct-1");
  });

  it("sessão identificada por assinatura válida: usa o contato identificado (não cria outro)", async () => {
    const s = session({ contactId: "ct-ident" });
    // posse falha (o contato não nasceu na sessão)…
    mocks.prisma.contact.findFirst.mockResolvedValueOnce(null);
    // …mas a sessão tem identityVerifiedAt para esse contato
    mocks.prisma.webchatSession.findFirst.mockResolvedValueOnce({ id: s.id });
    mocks.prisma.contact.findFirst.mockResolvedValueOnce({ id: "ct-ident", name: "Pessoa Um" });
    const res = await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Oi",
    });
    expect(mocks.prisma.webchatSession.findFirst).toHaveBeenCalledWith({
      where: { id: s.id, contactId: "ct-ident", identityVerifiedAt: { not: null } },
      select: { id: true },
    });
    expect(mocks.insertContact).not.toHaveBeenCalled();
    expect(res.contactId).toBe("ct-ident");
  });

  it("ref do open({ ref }) vira metadado da conversa (fonte widget)", async () => {
    const s = session();
    await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Oi",
      ref: "REF-1",
      refDealCustomFieldId: "cf-deal",
    });
    expect(mocks.recordRef).toHaveBeenCalledWith({
      conversationId: "conv-1",
      contactId: "ct-1",
      ref: "REF-1",
      source: "widget",
      refDealCustomFieldId: "cf-deal",
    });
  });

  it("clientMessageId repetido devolve a mesma mensagem sem novos efeitos", async () => {
    const s = session({ contactId: "ct-1" });
    mocks.prisma.message.findFirst.mockResolvedValue({
      id: "msg-1",
      externalId: webchatExternalId(s.id, "c1"),
      conversationId: "conv-1",
      content: "Olá",
      createdAt: NOW,
    });
    const res = await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Olá",
    });
    expect(res.duplicate).toBe(true);
    expect(res.message.id).toBe("msg-1");
    expect(mocks.prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: `wc:${s.id}:c1` } }),
    );
    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
    expect(mocks.publishNewMessage).not.toHaveBeenCalled();
    expect(mocks.fireTrigger).not.toHaveBeenCalled();
    expect(mocks.onAi).not.toHaveBeenCalled();
  });

  it("corrida no unique (org, externalId): perdedor devolve a gravada, sem SSE/gatilho", async () => {
    const s = session({ contactId: "ct-1" });
    mocks.prisma.contact.findFirst.mockResolvedValue({ id: "ct-1", name: "Ana" });
    mocks.prisma.conversation.findFirst.mockResolvedValue({ id: "conv-1", channelId: "ch-1", assignedToId: null });
    mocks.dedup.lose = true;
    mocks.prisma.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "msg-9", externalId: "x", conversationId: "conv-1", content: "Oi", createdAt: NOW });
    const res = await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c1",
      content: "Oi",
    });
    expect(res).toMatchObject({ duplicate: true, message: { id: "msg-9" } });
    expect(mocks.insertContact).not.toHaveBeenCalled();
    expect(mocks.publishNewMessage).not.toHaveBeenCalled();
    expect(mocks.fireTrigger).not.toHaveBeenCalledWith("message_received", expect.anything());
    expect(mocks.onAi).not.toHaveBeenCalled();
  });

  it("contato existente e ticket aberto: não recria contato nem ticket", async () => {
    const s = session({ contactId: "ct-1" });
    mocks.prisma.contact.findFirst.mockResolvedValue({ id: "ct-1", name: "Ana" });
    mocks.prisma.conversation.findFirst.mockResolvedValue({ id: "conv-7", channelId: "ch-1", assignedToId: "u-1" });
    const res = await processWebchatInbound({
      organizationId: "org-1",
      channelId: "ch-1",
      session: s,
      clientMessageId: "c2",
      content: "De novo",
    });
    expect(res).toMatchObject({ duplicate: false, conversationId: "conv-7", contactId: "ct-1" });
    expect(mocks.insertContact).not.toHaveBeenCalled();
    expect(mocks.prisma.conversation.create).not.toHaveBeenCalled();
    expect(mocks.fireTrigger).not.toHaveBeenCalledWith("contact_created", expect.anything());
    expect(mocks.publishNewMessage).toHaveBeenCalledWith(expect.objectContaining({ assignedToId: "u-1" }));
  });
});
