/**
 * `services/outbound-messaging` — envio humano/integração sem Postgres,
 * Redis ou Meta (CL-15).
 *
 * Cobre:
 *  - `sendTextToConversation`: grava a mensagem com `organizationId` do
 *    contexto, entrega ao provedor, marca a conversa como respondida,
 *    publica `new_message` com `organizationId`, loga MESSAGE_SENT e
 *    dispara efeitos colaterais; erro do provedor marca `hasError` e
 *    devolve `metaError` sem derrubar o envio; validações (400/404/409/403).
 *  - `sendTemplateToConversation`: mensagem `pending` + job na fila
 *    `meta-outbound` com `organizationId`; fila indisponível marca
 *    `failed` + `hasError`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    messageCreate: vi.fn(),
    messageCount: vi.fn().mockResolvedValue(1),
    messageUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
    conversationUpdate: vi.fn().mockResolvedValue({}),
    conversationFindUnique: vi.fn(),
    templateConfigFindFirst: vi.fn().mockResolvedValue(null),
    getConversationLite: vi.fn(),
    reopenResolvedAsNewTicket: vi.fn(),
    requireChannelScope: vi.fn().mockResolvedValue(null as Response | null),
    resolveOutboundChannel: vi.fn(),
    metaConfigured: vi.fn().mockReturnValue(true),
    isBaileysChannel: vi.fn().mockReturnValue(false),
    sendWhatsAppText: vi.fn(),
    getContactWhatsAppTargets: vi.fn().mockResolvedValue({ to: "5511987654321", recipient: undefined }),
    enqueueMetaOutbound: vi.fn(),
    ssePublish: vi.fn(),
    logEvent: vi.fn().mockResolvedValue(undefined),
    cancelActiveContexts: vi.fn().mockResolvedValue(0),
    fireTrigger: vi.fn().mockResolvedValue(undefined),
    cancelPending: vi.fn().mockResolvedValue(undefined),
    createConversationEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      create: h.messageCreate,
      count: h.messageCount,
      updateMany: h.messageUpdateMany,
    },
    conversation: { update: h.conversationUpdate, findUnique: h.conversationFindUnique },
    whatsAppTemplateConfig: { findFirst: h.templateConfigFindFirst },
  },
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: h.ssePublish } }));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingFor: vi.fn().mockResolvedValue(null),
  getOrgSetting: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/authz/resource-policy", () => ({ requireChannelScope: h.requireChannelScope }));
vi.mock("@/lib/contact-whatsapp-target", () => ({
  getContactWhatsAppTargets: h.getContactWhatsAppTargets,
}));
vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: () => ({ configured: h.metaConfigured() }),
}));
vi.mock("@/lib/queue", () => ({ enqueueMetaOutbound: h.enqueueMetaOutbound }));
vi.mock("@/lib/outbound-channel", () => ({ resolveOutboundChannel: h.resolveOutboundChannel }));
vi.mock("@/lib/send-whatsapp", () => ({
  sendWhatsAppText: h.sendWhatsAppText,
  isBaileysChannel: h.isBaileysChannel,
}));
vi.mock("@/lib/whatsapp-outbound-template-label", () => ({
  buildOutboundTemplateMessageContent: (name: string) => `[template] ${name}`,
}));
vi.mock("@/lib/human-actor-name", () => ({
  formatHumanActorDisplayName: (n?: string | null, e?: string | null) => n ?? e ?? null,
}));
vi.mock("@/services/activity-log", () => ({ logEvent: h.logEvent }));
vi.mock("@/services/automation-context", () => ({
  cancelActiveContextsForContactIfAny: h.cancelActiveContexts,
}));
vi.mock("@/services/whatsapp-flow-definitions", () => ({
  getPublishedFlowForSend: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/conversation-events", () => ({
  createConversationEvent: h.createConversationEvent,
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: h.fireTrigger,
  buildMessageTriggerData: (d: unknown) => d,
}));
vi.mock("@/services/conversations", () => ({
  getConversationLite: h.getConversationLite,
  reopenResolvedAsNewTicket: h.reopenResolvedAsNewTicket,
}));
vi.mock("@/services/scheduled-messages", () => ({
  cancelPendingForConversation: h.cancelPending,
}));

import { NextResponse } from "next/server";

import { HUMAN_OUTBOUND_REPLY_MARK } from "@/lib/conversation-reply-marking";
import { runWithContext } from "@/lib/request-context";
import {
  sendTemplateToConversation,
  sendTextToConversation,
} from "@/services/outbound-messaging";

const ORG = "org-a";
/** `createdAt` da mensagem gravada — vira `conversations.lastMessageAt` no mesmo update. */
const MESSAGE_CREATED_AT = new Date("2026-09-30T10:00:00Z");
const ACTOR = { id: "user-1", name: "Ana", email: "ana@x.com", role: "MEMBER", organizationId: ORG };

const CHANNEL = {
  id: "ch-1",
  provider: "META_CLOUD",
  config: { accessToken: "t", phoneNumberId: "p" },
  name: "Principal",
  phoneNumber: "+5511999990000",
  type: "WHATSAPP",
  status: "CONNECTED",
};

function convLite(over: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    externalId: null,
    contactId: "contact-1",
    status: "OPEN",
    channel: "whatsapp",
    channelId: "ch-1",
    waJid: null,
    organizationId: ORG,
    number: 10,
    createdAt: new Date("2026-09-30T09:00:00Z"),
    lastInboundAt: new Date("2026-09-30T09:30:00Z"),
    assignedToId: null,
    assignedTo: null,
    pinnedNoteId: null,
    channelRef: { ...CHANNEL },
    ...over,
  };
}

function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: orgId, userId: "user-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

function createdMessageData(): Record<string, unknown> {
  return (h.messageCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getConversationLite.mockResolvedValue(convLite());
  h.resolveOutboundChannel.mockImplementation(
    async (args: { conv: { channelRef: unknown; channelId: string | null } }) => ({
      ok: true,
      channelRef: args.conv.channelRef,
      channelId: args.conv.channelId,
    }),
  );
  h.requireChannelScope.mockResolvedValue(null);
  h.metaConfigured.mockReturnValue(true);
  h.isBaileysChannel.mockReturnValue(false);
  h.messageCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "msg-1",
    createdAt: MESSAGE_CREATED_AT,
    ...args.data,
  }));
  h.sendWhatsAppText.mockResolvedValue({ externalId: "wamid.1", failed: false, error: null });
  h.messageCount.mockResolvedValue(1);
  h.enqueueMetaOutbound.mockResolvedValue({ id: "job-1" });
  h.conversationFindUnique.mockResolvedValue({
    ...convLite(),
    contact: { phone: "+5511987654321", whatsappBsuid: null },
  });
  h.templateConfigFindFirst.mockResolvedValue(null);
});

describe("sendTextToConversation — caminho feliz", () => {
  it("grava a mensagem na org do contexto, entrega, marca resposta humana e publica new_message com organizationId", async () => {
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "  Olá!  " }),
    );

    expect(out).toMatchObject({
      ok: true,
      conversationId: "conv-1",
      message: { id: "msg-1", content: "Olá!", direction: "out", messageType: "text", senderName: "Ana", externalId: "wamid.1" },
    });
    expect(out).not.toHaveProperty("metaError");

    expect(createdMessageData()).toMatchObject({
      organizationId: ORG,
      conversationId: "conv-1",
      channelId: "ch-1",
      content: "Olá!",
      direction: "out",
      messageType: "text",
      senderName: "Ana",
    });
    expect(createdMessageData()).not.toHaveProperty("sendStatus");

    expect(h.sendWhatsAppText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        contactId: "contact-1",
        content: "Olá!",
        messageId: "msg-1",
      }),
    );
    expect(h.conversationUpdate).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { ...HUMAN_OUTBOUND_REPLY_MARK, hasError: false, lastMessageAt: MESSAGE_CREATED_AT },
    });
    expect(h.ssePublish).toHaveBeenCalledWith("new_message", {
      organizationId: ORG,
      conversationId: "conv-1",
      contactId: "contact-1",
      direction: "out",
      content: "Olá!",
      timestamp: new Date("2026-09-30T10:00:00Z"),
    });
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MESSAGE_SENT",
        entityId: "msg-1",
        conversationId: "conv-1",
        meta: expect.objectContaining({ via: "meta", externalId: "wamid.1" }),
      }),
    );
    // efeitos colaterais do envio humano
    expect(h.cancelActiveContexts).toHaveBeenCalledWith("contact-1");
    expect(h.fireTrigger).toHaveBeenCalledWith(
      "message_sent",
      expect.objectContaining({ contactId: "contact-1" }),
    );
    expect(h.cancelPending).toHaveBeenCalledWith("conv-1", "agent_reply", "user-1");
  });

  it("new_message carrega a org da CONVERSA (nunca vaza para outra org)", async () => {
    h.getConversationLite.mockResolvedValue(convLite({ organizationId: "org-conv" }));
    await withOrg("org-conv", () =>
      sendTextToConversation({ conversationId: "conv-1", actor: { ...ACTOR, organizationId: "org-conv" }, content: "x" }),
    );
    expect(h.ssePublish.mock.calls[0]![1]).toMatchObject({ organizationId: "org-conv" });
  });

  it("fora de contexto de org não grava mensagem", async () => {
    await expect(
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "x" }),
    ).rejects.toThrow(/RequestContext sem organizationId/);
    expect(h.sendWhatsAppText).not.toHaveBeenCalled();
    expect(h.ssePublish).not.toHaveBeenCalled();
  });

  it("stopAutomations=false não cancela o robô do contato", async () => {
    await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "x", stopAutomations: false }),
    );
    expect(h.cancelActiveContexts).not.toHaveBeenCalled();
    expect(h.fireTrigger).toHaveBeenCalled();
  });

  it("sem credenciais Meta (dev/mock) persiste como `sent` sem chamar o provedor", async () => {
    h.metaConfigured.mockReturnValue(false);
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "x" }),
    );
    expect(out.ok).toBe(true);
    expect(createdMessageData().sendStatus).toBe("sent");
    expect(h.sendWhatsAppText).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ via: "local" }) }),
    );
  });

  it("conversa RESOLVED: reabre como ticket novo e envia nele", async () => {
    h.getConversationLite
      .mockResolvedValueOnce(convLite({ status: "RESOLVED" }))
      .mockResolvedValueOnce(convLite({ id: "conv-2", status: "OPEN" }));
    h.reopenResolvedAsNewTicket.mockResolvedValue({ id: "conv-2", created: true });

    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "oi" }),
    );
    expect(h.reopenResolvedAsNewTicket).toHaveBeenCalledWith("conv-1");
    expect(out).toMatchObject({ ok: true, conversationId: "conv-2", reopenedConversationId: "conv-2" });
    expect(createdMessageData().conversationId).toBe("conv-2");
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CONVERSATION_CREATED",
        meta: expect.objectContaining({ source: "outbound_reopen", previousConversationId: "conv-1" }),
      }),
    );
  });
});

describe("sendTextToConversation — erro do provedor", () => {
  it("falha da Meta marca hasError na conversa, não loga MESSAGE_SENT e devolve metaError", async () => {
    h.sendWhatsAppText.mockResolvedValue({
      externalId: null,
      failed: true,
      error: "Meta 131047: fora da janela de 24h",
    });

    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "x" }),
    );

    expect(out).toMatchObject({
      ok: true,
      metaError: "Meta 131047: fora da janela de 24h",
      message: { id: "msg-1", externalId: null },
    });
    expect(h.conversationUpdate).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { ...HUMAN_OUTBOUND_REPLY_MARK, hasError: true, lastMessageAt: MESSAGE_CREATED_AT },
    });
    const logged = h.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(logged).not.toContain("MESSAGE_SENT");
    // a bolha (com falha) ainda aparece no inbox
    expect(h.ssePublish).toHaveBeenCalledWith("new_message", expect.objectContaining({ organizationId: ORG }));
  });

  it("falha ao atualizar a conversa (colunas antigas) não derruba o envio", async () => {
    h.conversationUpdate.mockRejectedValueOnce(new Error("column missing"));
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "x" }),
    );
    expect(out.ok).toBe(true);
  });
});

describe("sendTextToConversation — validações", () => {
  it("conteúdo vazio → 400 sem tocar no banco", async () => {
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "   " }),
    );
    expect(out).toEqual({ ok: false, status: 400, message: "Mensagem vazia." });
    expect(h.getConversationLite).not.toHaveBeenCalled();
    expect(h.messageCreate).not.toHaveBeenCalled();
  });

  it("conversa inexistente → 404; canal não-WhatsApp → 400", async () => {
    h.getConversationLite.mockResolvedValueOnce(null);
    expect(
      await withOrg(ORG, () => sendTextToConversation({ conversationId: "x", actor: ACTOR, content: "a" })),
    ).toMatchObject({ ok: false, status: 404 });

    h.getConversationLite.mockResolvedValueOnce(convLite({ channel: "instagram" }));
    expect(
      await withOrg(ORG, () => sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "a" })),
    ).toMatchObject({ ok: false, status: 400 });
    expect(h.messageCreate).not.toHaveBeenCalled();
  });

  it("canal desconectado → 409 e nada é gravado", async () => {
    h.getConversationLite.mockResolvedValueOnce(
      convLite({ channelRef: { ...CHANNEL, status: "DISCONNECTED" } }),
    );
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "a" }),
    );
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect((out as { message: string }).message).toMatch(/desconectado/);
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("sem permissão no canal → status e mensagem da policy (403)", async () => {
    h.requireChannelScope.mockResolvedValueOnce(
      NextResponse.json({ message: "Sem acesso a este canal." }, { status: 403 }),
    );
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "a" }),
    );
    expect(out).toEqual({ ok: false, status: 403, message: "Sem acesso a este canal." });
    expect(h.requireChannelScope).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1", organizationId: ORG }),
      "send",
      "ch-1",
    );
    expect(h.messageCreate).not.toHaveBeenCalled();
  });

  it("contato sem telefone/BSUID → 400 antes de gravar", async () => {
    h.getContactWhatsAppTargets.mockResolvedValueOnce(null as never);
    const out = await withOrg(ORG, () =>
      sendTextToConversation({ conversationId: "conv-1", actor: ACTOR, content: "a" }),
    );
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(h.messageCreate).not.toHaveBeenCalled();
  });
});

describe("sendTemplateToConversation", () => {
  const args = { conversationId: "conv-1", actor: ACTOR, templateName: "boas_vindas" };

  it("grava `pending` na org do contexto, publica new_message e enfileira com organizationId da conversa", async () => {
    const out = await withOrg(ORG, () => sendTemplateToConversation(args));

    expect(out).toMatchObject({
      ok: true,
      conversationId: "conv-1",
      sendStatus: "pending",
      message: { id: "msg-1", messageType: "template", content: "[template] boas_vindas", externalId: null },
    });
    expect(createdMessageData()).toMatchObject({
      organizationId: ORG,
      conversationId: "conv-1",
      messageType: "template",
      sendStatus: "pending",
      direction: "out",
    });
    expect(h.conversationUpdate).toHaveBeenCalledWith({
      where: { id: "conv-1" },
      data: { ...HUMAN_OUTBOUND_REPLY_MARK, hasError: false, lastMessageAt: MESSAGE_CREATED_AT },
    });
    expect(h.ssePublish).toHaveBeenCalledWith(
      "new_message",
      expect.objectContaining({ organizationId: ORG, conversationId: "conv-1", direction: "out" }),
    );
    expect(h.enqueueMetaOutbound).toHaveBeenCalledTimes(1);
    expect(h.enqueueMetaOutbound.mock.calls[0]![0]).toMatchObject({
      conversationId: "conv-1",
      messageId: "msg-1",
      organizationId: ORG,
      contactId: "contact-1",
      channelId: "ch-1",
      kind: "template",
      template: { templateName: "boas_vindas", languageCode: "pt_BR", actorId: "user-1" },
    });
    expect(h.cancelActiveContexts).toHaveBeenCalledWith("contact-1");
    expect(h.cancelPending).toHaveBeenCalledWith("conv-1", "agent_reply", "user-1");
    // já havia mensagem pública → não é "conversa iniciada por template"
    expect(h.createConversationEvent).not.toHaveBeenCalled();
  });

  it("primeira mensagem pública registra o evento 'Conversa iniciada por template'", async () => {
    h.messageCount.mockResolvedValueOnce(0);
    await withOrg(ORG, () => sendTemplateToConversation(args));
    expect(h.createConversationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", action: "template", actorUserId: "user-1" }),
    );
  });

  it("fila indisponível: mensagem `failed`, conversa com hasError e sendStatus failed", async () => {
    h.enqueueMetaOutbound.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await withOrg(ORG, () => sendTemplateToConversation(args));

    expect(out).toMatchObject({ ok: true, sendStatus: "failed" });
    expect((out as { metaError?: string }).metaError).toMatch(/Fila de envio indisponível/);
    expect(h.messageUpdateMany).toHaveBeenCalledWith({
      where: { id: "msg-1", sendStatus: "pending" },
      data: { sendStatus: "failed", sendError: expect.stringMatching(/Fila de envio/) },
    });
    expect(h.conversationUpdate).toHaveBeenLastCalledWith({
      where: { id: "conv-1" },
      data: { hasError: true },
    });
    warn.mockRestore();
  });

  it("usa a config local do template (idioma, graph id, flow) quando existe", async () => {
    h.templateConfigFindFirst.mockResolvedValueOnce({
      id: "tpl-cfg-1",
      category: "MARKETING",
      metaTemplateId: "graph-9",
      language: "en_US",
      hasButtons: true,
      buttonTypes: ["FLOW"],
    });
    await withOrg(ORG, () => sendTemplateToConversation(args));
    expect(h.enqueueMetaOutbound.mock.calls[0]![0]).toMatchObject({
      template: {
        languageCode: "en_US",
        templateGraphId: "graph-9",
        knownHasFlowButton: true,
        templateConfigId: "tpl-cfg-1",
      },
    });
    expect(createdMessageData().templateConfigId).toBe("tpl-cfg-1");
  });

  it("validações: nome vazio 400, conversa inexistente 404, canal Baileys 400, sem credenciais 503", async () => {
    expect(await withOrg(ORG, () => sendTemplateToConversation({ ...args, templateName: " " }))).toMatchObject({
      ok: false,
      status: 400,
    });

    h.conversationFindUnique.mockResolvedValueOnce(null);
    expect(await withOrg(ORG, () => sendTemplateToConversation(args))).toMatchObject({ ok: false, status: 404 });

    h.conversationFindUnique.mockResolvedValueOnce({
      ...convLite({ channelRef: { ...CHANNEL, provider: "BAILEYS_MD" } }),
      contact: { phone: "+5511987654321", whatsappBsuid: null },
    });
    expect(await withOrg(ORG, () => sendTemplateToConversation(args))).toMatchObject({ ok: false, status: 400 });

    h.metaConfigured.mockReturnValueOnce(false);
    expect(await withOrg(ORG, () => sendTemplateToConversation(args))).toMatchObject({ ok: false, status: 503 });

    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.enqueueMetaOutbound).not.toHaveBeenCalled();
  });

  it("scope de envio é checado no canal DE SAÍDA (override), não no do ticket", async () => {
    h.resolveOutboundChannel.mockResolvedValueOnce({
      ok: true,
      channelRef: { ...CHANNEL, id: "ch-2" },
      channelId: "ch-2",
    });
    await withOrg(ORG, () => sendTemplateToConversation({ ...args, channelId: "ch-2" }));
    expect(h.requireChannelScope).toHaveBeenCalledWith(expect.anything(), "send", "ch-2");
    expect(h.enqueueMetaOutbound.mock.calls[0]![0]).toMatchObject({ channelId: "ch-2" });
  });
});
