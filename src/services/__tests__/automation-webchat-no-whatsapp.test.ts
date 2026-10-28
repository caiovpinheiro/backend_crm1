/**
 * Automação disparada por mensagem do webchat (`message_received` sem
 * filtro de canal) não manda WhatsApp para o visitante: antes o passo caía
 * no 1º canal Meta da org (ou no singleton do .env) e enviava para o
 * telefone que o visitante digitou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const sendText = vi.fn();
  const client = { configured: true, sendText, sendTemplate: vi.fn(), sendMedia: vi.fn() };
  return {
    sendText,
    client,
    metaClientFromConfig: vi.fn(() => client),
    channelFindFirst: vi.fn(),
    conversationFindUnique: vi.fn(),
    conversationFindFirst: vi.fn(),
    ensureConv: vi.fn(),
    messageCreate: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findFirst: h.channelFindFirst },
    conversation: {
      findUnique: h.conversationFindUnique,
      findFirst: h.conversationFindFirst,
      update: vi.fn(async () => ({})),
    },
    message: { create: h.messageCreate, findFirst: vi.fn(async () => null) },
    contact: { findUnique: vi.fn(async () => ({ organizationId: "org-1" })) },
  },
}));
vi.mock("@/lib/meta-whatsapp/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/meta-whatsapp/client")>();
  return { ...real, metaClientFromConfig: h.metaClientFromConfig, metaWhatsApp: h.client };
});
vi.mock("@/services/whatsapp-conversation", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/whatsapp-conversation")>();
  return { ...real, ensureWhatsAppConversationForContact: h.ensureConv };
});
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => undefined),
  notifyDealStageChanged: vi.fn(),
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

import { MetaSendFailureError, executeStep } from "@/services/automation-executor";

const rt = {
  automationId: "auto-1",
  automationName: "Boas-vindas",
  contactId: "ct-1",
  dealId: null,
  event: "message_received",
  data: { channel: "webchat", channelId: "ch-wc", conversationId: "conv-wc", content: "Oi" },
  contact: { id: "ct-1", name: "Visitante", phone: "+5511999990000", whatsappBsuid: null },
  deal: null,
  conversation: null,
  contactTagIds: [],
  contactTagNames: [],
  dealTagIds: [],
  dealTagNames: [],
  contactCustomFields: {},
  dealCustomFields: {},
  depth: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.channelFindFirst.mockImplementation(async (args: { where: { id?: string } }) =>
    args.where.id === "ch-wc"
      ? { provider: "WEBCHAT", config: { publicKey: "wc_X", allowedOrigins: [] }, organizationId: "org-1" }
      : { provider: "META_CLOUD_API", config: { accessToken: "t", phoneNumberId: "p" }, organizationId: "org-1" },
  );
  h.conversationFindUnique.mockResolvedValue({
    channel: "webchat",
    organizationId: "org-1",
    channelRef: { provider: "WEBCHAT", config: { publicKey: "wc_X", allowedOrigins: [] } },
  });
  h.conversationFindFirst.mockResolvedValue({ id: "conv-wc", status: "OPEN" });
});

describe("automação × webchat", () => {
  it("send_whatsapp_message de gatilho do webchat falha (Falha ao enviar) sem tocar na Meta", async () => {
    await expect(
      executeStep("send_whatsapp_message", { content: "Bem-vindo!" }, rt as never),
    ).rejects.toBeInstanceOf(MetaSendFailureError);
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.metaClientFromConfig).not.toHaveBeenCalled();
    // Não abre ticket de WhatsApp para o visitante.
    expect(h.ensureConv).not.toHaveBeenCalled();
    expect(h.messageCreate).not.toHaveBeenCalled();
  });

  it("send_product (reaproveita o envio de texto) também não sai", async () => {
    const prisma = (await import("@/lib/prisma")).prisma as unknown as {
      product?: { findFirst: unknown };
    };
    prisma.product = {
      findFirst: vi.fn(async () => ({
        id: "p1",
        name: "Curso",
        description: null,
        sku: null,
        price: 100,
        unit: null,
      })),
    };
    await expect(executeStep("send_product", { productId: "p1" }, rt as never)).rejects.toBeInstanceOf(
      MetaSendFailureError,
    );
    expect(h.sendText).not.toHaveBeenCalled();
  });
});
