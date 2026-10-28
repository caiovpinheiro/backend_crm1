/**
 * Agente de IA em conversa webchat (docs/decisoes/webchat-widget.md §9.4):
 * a resposta é gravada para o widget (mesmo caminho do texto do composer) e
 * NADA sai pela Meta — o canal do widget não tem credencial e o cliente
 * global mandaria WhatsApp para o telefone que o visitante digitou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  metaClientFromConfig: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(async () => ({})),
  messageCreate: vi.fn(),
  messageFindMany: vi.fn(async () => []),
  messageFindFirst: vi.fn(async (): Promise<unknown> => null),
  isContactAllowedForAi: vi.fn(async () => true),
  publishNewMessage: vi.fn(),
  markTyping: vi.fn(async () => {}),
  cacheGet: vi.fn(async (): Promise<unknown> => undefined),
  notifyStatus: vi.fn(),
}));
vi.mock("@/lib/webchat/s2s/callback", () => ({ notifyWebchatConversationStatus: h.notifyStatus }));

vi.mock("@/lib/meta-whatsapp/client", () => ({ metaClientFromConfig: h.metaClientFromConfig }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: h.conversationFindUnique, update: h.conversationUpdate },
    message: { create: h.messageCreate, findMany: h.messageFindMany, findFirst: h.messageFindFirst },
    contact: { findUnique: vi.fn(async () => ({ phone: "+5500000000000" })) },
    user: { findUnique: vi.fn(async () => ({ name: "Assistente" })) },
  },
}));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getRequestContext: () => undefined }));
vi.mock("@/lib/realtime-events", () => ({
  publishNewMessage: h.publishNewMessage,
  publishConversationAssignment: vi.fn(),
}));
vi.mock("@/lib/cache", () => ({ cache: { get: h.cacheGet, set: vi.fn(async () => {}) } }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageChange: vi.fn(async () => {}) }));
vi.mock("@/lib/conversation-reply-marking", () => ({
  botOutboundReplyMark: vi.fn(async () => ({ lastMessageDirection: "out", hasAgentReply: true })),
}));
vi.mock("@/lib/conversation-last-message", () => ({ touchChatLastMessageAt: vi.fn(async () => {}) }));
vi.mock("@/lib/webchat/agent-typing", () => ({
  markWebchatAgentTyping: h.markTyping,
  WEBCHAT_AGENT_TYPING_TTL_SEC: 6,
}));
vi.mock("@/services/ai/phone-allowlist", () => ({ isContactAllowedForAi: h.isContactAllowedForAi }));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/services/conversation-events", () => ({ createConversationEvent: vi.fn(async () => null) }));

import { sendAgentMessage } from "@/services/ai/send-agent-message";

/** Uma linha que serve a todos os `conversation.findUnique` do fluxo. */
const WEBCHAT_CONV = {
  channel: "webchat",
  channelId: "ch-wc",
  channelRef: { provider: "WEBCHAT", status: "CONNECTED", name: "Site" },
  assignedToId: "ai-1",
  hasHumanReply: false,
  assignedTo: { type: "AI" },
};

const BASE = {
  conversationId: "conv-wc",
  contactId: "ct-1",
  agentUserId: "ai-1",
  text: "Olá! Posso ajudar?",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.messageFindMany.mockResolvedValue([]);
  h.messageFindFirst.mockResolvedValue(null);
  h.conversationFindUnique.mockResolvedValue(WEBCHAT_CONV);
  h.messageCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "msg-out-1",
    organizationId: "org-1",
    externalId: null,
    createdAt: new Date("2026-10-28T12:00:00Z"),
    ...data,
  }));
});

describe("sendAgentMessage × webchat", () => {
  it("AUTONOMOUS: grava a resposta para o widget (out, sent, bot) e não chama a Meta", async () => {
    const res = await sendAgentMessage({ ...BASE, autonomyMode: "AUTONOMOUS" });
    expect(res).toEqual({ status: "sent", messageId: "msg-out-1" });
    expect(h.metaClientFromConfig).not.toHaveBeenCalled();
    expect(h.messageCreate).toHaveBeenCalledTimes(1);
    expect(h.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conv-wc",
        channelId: "ch-wc",
        content: "Olá! Posso ajudar?",
        direction: "out",
        messageType: "text",
        authorType: "bot",
        aiAgentUserId: "ai-1",
        senderName: "Assistente",
        sendStatus: "sent",
      }),
    });
    const data = (h.messageCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.externalId).toBeUndefined();
    expect(data.isPrivate).toBeUndefined();
    expect(h.publishNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-wc", direction: "out", organizationId: "org-1" }),
    );
    // Callback "attended" do S2S (§9.6), como na resposta do composer.
    expect(h.notifyStatus).toHaveBeenCalledWith({
      organizationId: "org-1",
      conversationIds: ["conv-wc"],
      status: "attended",
      channel: "webchat",
    });
  });

  it("mensagem interativa vira o texto com as opções (sem botões da Meta)", async () => {
    const res = await sendAgentMessage({
      ...BASE,
      autonomyMode: "AUTONOMOUS",
      text: "Escolha:\n1. Opção A\n2. Opção B",
      interactive: {
        kind: "buttons",
        body: "Escolha:",
        options: [
          { id: "a", title: "Opção A" },
          { id: "b", title: "Opção B" },
        ],
        listButton: "Ver",
        displayContent: "Escolha: [A] [B]",
      },
    });
    expect(res.status).toBe("sent");
    expect(h.metaClientFromConfig).not.toHaveBeenCalled();
    expect(h.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: "Escolha:\n1. Opção A\n2. Opção B", messageType: "text" }),
    });
  });

  it("digitando…: acende o indicador do widget antes de gravar", async () => {
    vi.useFakeTimers();
    try {
      const p = sendAgentMessage({
        ...BASE,
        autonomyMode: "AUTONOMOUS",
        humanBehavior: { simulateTyping: true, typingPerCharMs: 0, markMessagesRead: false, maxTypingMs: 1000 },
      });
      await vi.runAllTimersAsync();
      expect((await p).status).toBe("sent");
      expect(h.markTyping).toHaveBeenCalledWith("org-1", "conv-wc");
    } finally {
      vi.useRealTimers();
    }
  });

  it("humano assumiu no meio do turno → não grava", async () => {
    h.conversationFindUnique.mockResolvedValue({ ...WEBCHAT_CONV, assignedTo: { type: "HUMAN" } });
    const res = await sendAgentMessage({ ...BASE, autonomyMode: "AUTONOMOUS" });
    expect(res).toEqual({ status: "skipped", reason: "assignee_not_ai" });
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.notifyStatus).not.toHaveBeenCalled();
    expect(h.metaClientFromConfig).not.toHaveBeenCalled();
  });

  it("modo rascunho: sem rascunho nem Meta (aprovar no webchat não se aplica)", async () => {
    const res = await sendAgentMessage({ ...BASE, autonomyMode: "DRAFT" });
    expect(res).toEqual({ status: "skipped", reason: "webchat_requires_autonomous" });
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.metaClientFromConfig).not.toHaveBeenCalled();
  });

  it("conversa WhatsApp continua no caminho da Meta (regressão)", async () => {
    h.conversationFindUnique.mockResolvedValue({
      ...WEBCHAT_CONV,
      channel: "whatsapp",
      channelRef: { provider: "META_CLOUD_API", status: "CONNECTED", config: {} },
    });
    h.metaClientFromConfig.mockReturnValue({
      configured: true,
      sendText: vi.fn(async () => ({ messages: [{ id: "wamid.1" }] })),
    });
    const res = await sendAgentMessage({ ...BASE, autonomyMode: "AUTONOMOUS" });
    expect(res.status).toBe("sent");
    expect(h.metaClientFromConfig).toHaveBeenCalled();
  });
});
