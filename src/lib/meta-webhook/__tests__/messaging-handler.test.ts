/**
 * Webhook Instagram/Messenger — API só valida, audita e enfileira; o
 * worker processa. Sem banco/Redis reais: Prisma, cache e fila mockados.
 */
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  const memory = new Map<string, unknown>();
  return {
    logger,
    memory,
    enqueue: vi.fn(),
    fetch: vi.fn(),
    insertContact: vi.fn(),
    prisma: {
      message: { findFirst: vi.fn(), create: vi.fn() },
      contact: { findFirst: vi.fn() },
      conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    },
    prismaBase: {
      channel: { findFirst: vi.fn(), findMany: vi.fn() },
      metaWebhookEvent: { create: vi.fn(), update: vi.fn() },
    },
  };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: mocks.prismaBase }));
vi.mock("@/lib/cache", () => ({
  cache: {
    get: async (key: string) => mocks.memory.get(key),
    set: async (key: string, value: unknown) => {
      mocks.memory.set(key, value);
    },
    del: async (...keys: string[]) => keys.forEach((k) => mocks.memory.delete(k)),
    delPattern: async () => 0,
    wrap: async (key: string, _ttl: number, loader: () => Promise<unknown>) => {
      if (mocks.memory.has(key)) return mocks.memory.get(key);
      const v = await loader();
      mocks.memory.set(key, v);
      return v;
    },
  },
}));
vi.mock("@/lib/queue", () => ({ enqueueMetaWebhookEvent: mocks.enqueue }));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/message-dedup", () => ({
  createMessageDedup: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/meta-constants", () => ({ CRM_META_APP_SECRET: "test-secret" }));
vi.mock("@/lib/crypto/secrets", () => ({
  decryptSecret: (v: string) => v,
  isEncryptedSecret: () => false,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/ai/turn-manager", () => ({
  onInboundMessageForAi: vi.fn(async () => {}),
}));
vi.mock("@/services/conversations", () => ({
  activeConversationOnAccountWhere: (a: unknown) => a,
  isActiveConversationUniqueViolation: () => false,
  withConversationNumberRetry: (fn: (n: number) => Promise<unknown>) => fn(1),
}));
vi.mock("@/services/distribution", () => ({
  maybeDistributeNewInboundTicket: vi.fn(async () => {}),
}));
vi.mock("@/services/ai/attendance-gate", () => ({
  inheritContactAssigneeForNewTicket: async () => null,
}));
vi.mock("@/services/contacts", () => ({
  insertContactWithNextNumber: mocks.insertContact,
  isPrismaUniqueViolation: () => false,
}));
vi.mock("@/lib/web-push", () => ({ notifyInboundMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/conversation-inbound", () => ({
  touchInbound: vi.fn(async () => {}),
  warnTouchInboundFailed: vi.fn(),
}));
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => {}),
  buildMessageTriggerData: (d: unknown) => d,
  emitConversationCreated: vi.fn(),
  openingMessageTriggerExtra: () => ({}),
}));
vi.mock("@/services/auto-deals", () => ({
  ensureOpenDealForContact: vi.fn(async () => {}),
}));

import {
  handleMessagingWebhookPost,
  messagingWebhookJobId,
  processMessagingWebhookPayload,
} from "@/lib/meta-webhook/messaging-handler";

const CHANNEL = {
  id: "ch-1",
  organizationId: "org-1",
  type: "FACEBOOK",
  provider: "META_CLOUD_API",
  config: { pageId: "page-1", accessToken: "tok" },
};

function messengerBody(mid = "m.1", psid = "psid-1") {
  return {
    object: "page",
    entry: [
      {
        id: "page-1",
        time: 1700000000000,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: "page-1" },
            timestamp: 1700000000000,
            message: { mid, text: "oi" },
          },
        ],
      },
    ],
  };
}

function signedRequest(body: unknown, secret = "test-secret"): Request {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  return new Request("http://localhost/api/webhooks/meta/messaging", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memory.clear();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.prismaBase.channel.findFirst.mockResolvedValue(CHANNEL);
  mocks.prismaBase.channel.findMany.mockResolvedValue([]);
  mocks.prismaBase.metaWebhookEvent.create.mockResolvedValue({ id: "evt-1" });
  mocks.prismaBase.metaWebhookEvent.update.mockResolvedValue({});
  mocks.enqueue.mockResolvedValue({ id: "job-1" });
  mocks.prisma.message.findFirst.mockResolvedValue(null);
  mocks.prisma.message.create.mockResolvedValue({ id: "msg-1" });
  mocks.prisma.contact.findFirst.mockResolvedValue(null);
  mocks.prisma.conversation.findFirst.mockResolvedValue(null);
  mocks.prisma.conversation.create.mockResolvedValue({ id: "conv-1", assignedToId: null });
  mocks.insertContact.mockImplementation(async (fields: { name: string }) => ({
    id: "contact-1",
    name: fields.name,
  }));
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({ name: "Maria Silva" }),
  });
});

describe("handleMessagingWebhookPost (API)", () => {
  it("valida assinatura, audita, enfileira e responde 200 sem processar", async () => {
    const res = await handleMessagingWebhookPost(signedRequest(messengerBody()));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "accepted" });

    expect(mocks.prismaBase.metaWebhookEvent.create).toHaveBeenCalledTimes(1);
    const created = mocks.prismaBase.metaWebhookEvent.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      organizationId: "org-1",
      channelId: "ch-1",
      objectType: "page",
      eventType: "message",
      signatureValid: true,
    });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { metaWebhookEventId: "evt-1", organizationId: "org-1" },
      { jobId: expect.stringMatching(/^meta-msg-[0-9a-f]{40}$/) },
    );

    // Nada do loop pesado roda na request.
    expect(mocks.prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reenvio da Meta com o mesmo corpo gera o mesmo jobId", async () => {
    const body = messengerBody();
    await handleMessagingWebhookPost(signedRequest(body));
    mocks.prismaBase.metaWebhookEvent.create.mockResolvedValueOnce({ id: "evt-2" });
    await handleMessagingWebhookPost(signedRequest(body));

    const [first, second] = mocks.enqueue.mock.calls.map((c) => c[1].jobId);
    expect(first).toBe(second);
    expect(messagingWebhookJobId(JSON.stringify(body))).toBe(first);
    expect(messagingWebhookJobId(JSON.stringify(messengerBody("m.2")))).not.toBe(first);
  });

  it("assinatura inválida → 401 sem auditar nem enfileirar", async () => {
    const res = await handleMessagingWebhookPost(signedRequest(messengerBody(), "outro"));
    expect(res.status).toBe(401);
    expect(mocks.prismaBase.metaWebhookEvent.create).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("fila indisponível → 503 para a Meta reenviar (sem processar na API)", async () => {
    mocks.enqueue.mockResolvedValueOnce(null);
    const res = await handleMessagingWebhookPost(signedRequest(messengerBody()));
    expect(res.status).toBe(503);
    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
  });

  it("entry.id sem canal → 200 ignorado, sem enfileirar", async () => {
    mocks.prismaBase.channel.findFirst.mockResolvedValue(null);
    const res = await handleMessagingWebhookPost(signedRequest(messengerBody()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ignored_unmapped_channel" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.prismaBase.metaWebhookEvent.create).not.toHaveBeenCalled();
  });

  it("encaminhado da URL WhatsApp com evento já auditado → não grava segundo evento", async () => {
    const res = await handleMessagingWebhookPost(signedRequest(messengerBody()), {
      skipSignature: true,
      metaWebhookEventId: "evt-wa",
    });
    expect(res.status).toBe(200);
    expect(mocks.prismaBase.metaWebhookEvent.create).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { metaWebhookEventId: "evt-wa", organizationId: "org-1" },
      expect.anything(),
    );
  });

  it("mapeamento entry.id → org fica em cache entre POSTs", async () => {
    await handleMessagingWebhookPost(signedRequest(messengerBody("m.1")));
    await handleMessagingWebhookPost(signedRequest(messengerBody("m.2")));
    expect(mocks.prismaBase.channel.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("processMessagingWebhookPayload (worker)", () => {
  it("processa a entry: contato com nome do Graph, mensagem gravada, evento marcado", async () => {
    await processMessagingWebhookPayload(messengerBody(), { metaWebhookEventId: "evt-1" });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const init = mocks.fetch.mock.calls[0][1] as { signal?: unknown };
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(mocks.insertContact).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Maria Silva", messengerPsid: "psid-1" }),
      expect.anything(),
    );
    expect(mocks.prisma.message.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.message.create.mock.calls[0][0].data).toMatchObject({
      conversationId: "conv-1",
      channelId: "ch-1",
      direction: "in",
      content: "oi",
      externalId: "m.1",
    });
    expect(mocks.prismaBase.metaWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { processed: true, processingError: null },
    });
  });

  it("timeout do Graph no perfil não derruba o job (nome de fallback)", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    mocks.fetch.mockRejectedValueOnce(timeout);

    await processMessagingWebhookPayload(messengerBody(), { metaWebhookEventId: "evt-1" });

    expect(mocks.insertContact).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Messenger psid-1" }),
      expect.anything(),
    );
    expect(mocks.prisma.message.create).toHaveBeenCalledTimes(1);
    expect(mocks.prismaBase.metaWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { processed: true, processingError: null },
    });
  });

  it("nome do perfil é cacheado por PSID (segundo evento não bate no Graph)", async () => {
    await processMessagingWebhookPayload(messengerBody("m.1"), { metaWebhookEventId: "evt-1" });
    await processMessagingWebhookPayload(messengerBody("m.2"), { metaWebhookEventId: "evt-2" });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.insertContact).toHaveBeenCalledTimes(2);
    expect(mocks.insertContact.mock.calls[1][0]).toMatchObject({ name: "Maria Silva" });
  });

  it("reenvio já gravado (mid existente) não duplica a mensagem", async () => {
    mocks.prisma.message.findFirst.mockResolvedValueOnce({ id: "msg-old" });
    await processMessagingWebhookPayload(messengerBody(), { metaWebhookEventId: "evt-1" });
    expect(mocks.prisma.message.create).not.toHaveBeenCalled();
    expect(mocks.prismaBase.metaWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: "evt-1" },
      data: { processed: true, processingError: null },
    });
  });
});
