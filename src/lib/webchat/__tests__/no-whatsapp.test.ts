/**
 * Conversa/canal webchat nunca sai pela Meta: o cliente montado do config
 * do canal WEBCHAT não é o singleton do .env (mesmo com ele configurado) e
 * `sendWhatsAppText`/`sendWhatsAppMedia` recusam sem rede nem fila.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // Singleton do .env CONFIGURADO: é o fallback que vazava o envio.
  process.env.META_WHATSAPP_ACCESS_TOKEN = "env-token";
  process.env.META_WHATSAPP_PHONE_NUMBER_ID = "env-phone";
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    messageUpdate: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "m1", ...args.data })),
    channelFindUnique: vi.fn(),
    enqueue: vi.fn(),
    logMessageFailed: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => h.logger }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: { update: h.messageUpdate },
    channel: { findUnique: h.channelFindUnique },
    contact: { findUnique: vi.fn(async () => ({ name: "Visitante", phone: "+5511999990000" })) },
  },
}));
vi.mock("@/lib/queue", () => ({
  enqueueBaileysOutbound: h.enqueue,
  BaileysOutboundAlreadyQueuedError: class extends Error {},
}));
vi.mock("@/lib/contact-whatsapp-target", () => ({
  getContactWhatsAppTargets: vi.fn(async () => ({ to: "5511999990000", recipient: undefined })),
}));
vi.mock("@/services/activity-log", () => ({ logMessageFailed: h.logMessageFailed }));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageRowChange: vi.fn(async () => {}) }));

import { metaClientFromConfig, metaWhatsApp } from "@/lib/meta-whatsapp/client";
import { sendWhatsAppMedia, sendWhatsAppText } from "@/lib/send-whatsapp";
import {
  WEBCHAT_UNSUPPORTED_SEND_MESSAGE,
  isWebchatConversation,
  looksLikeWebchatChannelConfig,
} from "@/lib/webchat/outbound-guard";

const WEBCHAT_CONFIG = {
  publicKey: "wc_ABCDEFGHIJKLMNOPQRSTUVWX",
  allowedOrigins: ["https://www.cliente.com.br"],
  identification: "none",
};

const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy.mockImplementation(async () => {
    throw new Error("rede não pode ser chamada");
  });
});

afterAll(() => {
  fetchSpy.mockRestore();
});

describe("metaClientFromConfig × canal WEBCHAT", () => {
  it("o singleton do .env está configurado (pré-condição do teste)", () => {
    expect(metaWhatsApp.configured).toBe(true);
    expect(metaClientFromConfig(null)).toBe(metaWhatsApp);
  });

  it("config de canal webchat → cliente vazio, nunca o singleton", () => {
    const client = metaClientFromConfig(WEBCHAT_CONFIG);
    expect(client).not.toBe(metaWhatsApp);
    expect(client.configured).toBe(false);
    expect(metaClientFromConfig({ allowedOrigins: [] }).configured).toBe(false);
  });

  it("detecção do config e da conversa webchat", () => {
    expect(looksLikeWebchatChannelConfig(WEBCHAT_CONFIG)).toBe(true);
    expect(looksLikeWebchatChannelConfig({ accessToken: "t", phoneNumberId: "p" })).toBe(false);
    expect(isWebchatConversation({ channel: "webchat" })).toBe(true);
    expect(isWebchatConversation({ channel: "x", channelRef: { provider: "WEBCHAT" } })).toBe(true);
    expect(isWebchatConversation({ channel: "whatsapp", channelRef: { provider: "META_CLOUD_API" } })).toBe(
      false,
    );
  });
});

describe("send-whatsapp × canal WEBCHAT", () => {
  const base = {
    conversationId: "conv-wc",
    contactId: "ct-1",
    channelRef: { id: "ch-wc", provider: "WEBCHAT" },
    messageId: "msg-1",
  };

  it("texto: marca falha clara, sem Meta, sem fila e sem ler o canal", async () => {
    const res = await sendWhatsAppText({ ...base, content: "oi" });
    expect(res).toEqual({ externalId: null, failed: true, error: WEBCHAT_UNSUPPORTED_SEND_MESSAGE });
    expect(h.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "msg-1" },
        data: { sendStatus: "failed", sendError: WEBCHAT_UNSUPPORTED_SEND_MESSAGE },
      }),
    );
    expect(h.channelFindUnique).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mídia: recusa sem Meta nem fila", async () => {
    const res = await sendWhatsAppMedia({
      ...base,
      mediaUrl: "/api/storage/org/attachments/a.png",
      messageType: "image",
    });
    expect(res).toEqual({ externalId: null, failed: true, error: WEBCHAT_UNSUPPORTED_SEND_MESSAGE });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
