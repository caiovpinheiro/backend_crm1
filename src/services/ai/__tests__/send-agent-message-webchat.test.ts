/**
 * Agente de IA em conversa webchat: nada sai pela Meta. O canal do widget
 * não tem credencial e o cliente caía no singleton do .env, mandando
 * WhatsApp para o telefone que o visitante digitou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  metaClientFromConfig: vi.fn(),
  conversationFindUnique: vi.fn(),
  messageCreate: vi.fn(),
  messageFindMany: vi.fn(async () => []),
  isContactAllowedForAi: vi.fn(async () => true),
}));

vi.mock("@/lib/meta-whatsapp/client", () => ({ metaClientFromConfig: h.metaClientFromConfig }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: h.conversationFindUnique },
    message: { create: h.messageCreate, findMany: h.messageFindMany, findFirst: vi.fn(async () => null) },
    contact: { findUnique: vi.fn(async () => ({ phone: "+5511999990000" })) },
    user: { findUnique: vi.fn(async () => ({ name: "Agente IA" })) },
  },
}));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getRequestContext: () => undefined }));
vi.mock("@/lib/realtime-events", () => ({
  publishNewMessage: vi.fn(),
  publishConversationAssignment: vi.fn(),
}));
vi.mock("@/lib/cache", () => ({ cache: { get: vi.fn(async () => undefined) } }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageChange: vi.fn(async () => {}) }));
vi.mock("@/services/ai/phone-allowlist", () => ({ isContactAllowedForAi: h.isContactAllowedForAi }));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/services/conversation-events", () => ({ createConversationEvent: vi.fn(async () => null) }));

import { sendAgentMessage } from "@/services/ai/send-agent-message";

beforeEach(() => {
  vi.clearAllMocks();
  h.messageFindMany.mockResolvedValue([]);
});

describe("sendAgentMessage × webchat", () => {
  it("AUTONOMOUS em conversa webchat → skipped, sem cliente Meta e sem rascunho", async () => {
    h.conversationFindUnique.mockResolvedValue({
      channel: "webchat",
      channelRef: { provider: "WEBCHAT" },
    });
    const res = await sendAgentMessage({
      conversationId: "conv-wc",
      contactId: "ct-1",
      agentUserId: "ai-1",
      autonomyMode: "AUTONOMOUS",
      text: "Olá! Posso ajudar?",
      bypassAssigneeCheck: true,
    });
    expect(res).toEqual({ status: "skipped", reason: "webchat_unsupported" });
    expect(h.metaClientFromConfig).not.toHaveBeenCalled();
    expect(h.messageCreate).not.toHaveBeenCalled();
  });
});
