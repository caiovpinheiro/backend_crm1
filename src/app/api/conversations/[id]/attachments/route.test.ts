/**
 * POST /api/conversations/:id/attachments (B4) — canal Meta:
 * - 201 assim que o arquivo está salvo e a mensagem existe como `pending`;
 *   nenhuma chamada à Graph na requisição (upload + envio no worker, fila
 *   `meta-attach`);
 * - espera o worker só com `waitUntilSent: true` (pedido do cliente);
 * - fila indisponível → mensagem `failed` + `metaError` (o front mostra o
 *   erro e o "reenviar");
 * - idempotência: `jobId = meta-attach-<messageId>` (BullMQ deduplica);
 * - acesso e conversa numa leitura só; `Server-Timing` por fase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-queue.localhost:6379";
  return {
    conv: {
      id: "conv_1",
      externalId: null,
      contactId: "contact_1",
      status: "OPEN",
      channel: "whatsapp",
      channelId: "ch_1",
      waJid: null,
      organizationId: "org_1",
      number: 7,
      createdAt: new Date("2026-10-05T10:00:00Z"),
      lastInboundAt: new Date(),
      assignedToId: "user_a",
      assignedTo: null,
      pinnedNoteId: null,
      channelRef: {
        id: "ch_1",
        provider: "META_CLOUD_API",
        config: { phoneNumberId: "p1" },
        name: "Canal",
        phoneNumber: null,
        type: "WHATSAPP",
        status: "ACTIVE",
      },
    },
    calls: [] as string[],
    enqueue: vi.fn(),
    wait: vi.fn(),
    publish: vi.fn(),
    graph: vi.fn(),
    queueAdd: vi.fn(),
  };
});

vi.mock("@/lib/auth-helpers", async () => {
  const { runWithContext } = await import("@/lib/request-context");
  return {
    withOrgContext: async (handler: (s: unknown) => unknown) =>
      runWithContext(
        { organizationId: "org_1", userId: "user_a", isSuperAdmin: false } as never,
        () =>
          handler({
            user: { id: "user_a", name: "Ana", organizationId: "org_1", role: "MEMBER" },
          }),
      ),
  };
});
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/conversation-access", () => ({
  requireConversationAccessAndLoad: vi.fn(
    async (_s: unknown, id: string, load: (w: unknown) => Promise<unknown>) => ({
      conversation: await load({ id }),
    }),
  ),
}));
vi.mock("@/lib/prisma", () => {
  const track =
    <T>(label: string, result: (args: Record<string, unknown>) => T) =>
    vi.fn(async (args: Record<string, unknown>) => {
      h.calls.push(label);
      return result(args);
    });
  return {
    prisma: {
      conversation: {
        findFirst: track("conversation.findFirst", () => h.conv),
        findUnique: track("conversation.findUnique", () => h.conv),
        update: track("conversation.update", () => h.conv),
      },
      message: {
        create: track("message.create", (args) => ({
          id: "msg_1",
          createdAt: new Date("2026-10-05T10:01:00Z"),
          ...(args.data as Record<string, unknown>),
        })),
        updateMany: track("message.updateMany", () => ({ count: 1 })),
      },
      contact: {
        findUnique: track("contact.findUnique", () => ({ phone: "+55 11 99999-0000", whatsappBsuid: null })),
      },
      messageTemplate: { findMany: track("messageTemplate.findMany", () => []) },
    },
  };
});
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/authz/resource-policy", () => ({ requireChannelScope: vi.fn(async () => null) }));
vi.mock("@/lib/outbound-channel", () => ({
  resolveOutboundChannel: vi.fn(async () => ({
    ok: true,
    channelRef: h.conv.channelRef,
    channelId: h.conv.channelId,
  })),
}));
vi.mock("@/lib/channel-session", () => ({
  getConversationSession: vi.fn(async () => ({ active: true })),
  getContactChannelSession: vi.fn(async () => ({ active: true })),
}));
vi.mock("@/lib/audio-convert", () => ({
  WHATSAPP_VIDEO_MAX_BYTES: 16 * 1024 * 1024,
  WHATSAPP_VIDEO_TOO_LARGE_MESSAGE: "grande",
}));
vi.mock("@/lib/file-sniff", () => ({
  sniffAttachment: () => ({ mime: "image/png", ext: "png" }),
}));
vi.mock("@/lib/storage/local", () => ({
  generateFileName: () => "att-1.png",
  saveFile: vi.fn(async () => ({ url: "/api/storage/org_1/attachments/att-1.png" })),
  locateReusableStoredObject: vi.fn(async (p: { url: string }) => ({
    url: p.url,
    orgId: "org_1",
    bucket: "automation-media",
    fileName: "capa.png",
  })),
  resolveOrgOwnedReuseUrl: (raw: string) =>
    raw ? { url: raw, orgId: "org_1", bucket: "automation-media", fileName: "capa.png" } : null,
  resolveOutboundAttachmentMime: () => "image/png",
  reuseFileNameAliases: (n: string) => [n],
  statStoredFile: vi.fn(async () => null),
}));
vi.mock("@/lib/storage/ingest-product-cover", () => ({
  ingestProductCoverForReuse: vi.fn(async () => null),
}));
vi.mock("@/lib/storage/upstream-fallback", () => ({
  readUpstreamFallbackBytes: vi.fn(async () => null),
}));
vi.mock("@/lib/queue", () => ({ enqueueMetaAttach: h.enqueue }));
vi.mock("@/lib/meta-whatsapp/client", () => ({
  // Qualquer método da Graph chamado na rota quebra o teste.
  metaClientFromConfig: () =>
    new Proxy(
      { configured: true },
      {
        get: (target, prop) =>
          prop in target ? target[prop as "configured"] : (...args: unknown[]) => h.graph(prop, args),
      },
    ),
}));
vi.mock("@/lib/send-whatsapp", () => ({
  isBaileysChannel: () => false,
  sendWhatsAppMedia: vi.fn(),
}));
vi.mock("@/lib/realtime-events", () => ({ publishNewMessage: h.publish }));
vi.mock("@/services/conversations", async () => ({
  getConversationLite: vi.fn(async () => h.conv),
  reopenResolvedAsNewTicket: vi.fn(async () => ({ id: "conv_1" })),
}));
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: vi.fn(async () => undefined) }));
vi.mock("@/services/scheduled-messages", () => ({
  cancelPendingForConversation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wait-message-send-status", () => ({ waitForMessageSendStatus: h.wait }));
vi.mock("@/services/activity-log", () => ({ logEvent: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/conversations/[id]/attachments/route";

function uploadRequest(): Request {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "foto.png", { type: "image/png" }));
  form.append("caption", "segue");
  return new Request("http://localhost/api/conversations/conv_1/attachments", {
    method: "POST",
    body: form,
  });
}

function reuseRequest(extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/conversations/conv_1/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reuseUrl: "/api/storage/org_1/automation-media/capa.png", ...extra }),
  });
}

const ctx = { params: Promise.resolve({ id: "conv_1" }) };

beforeEach(() => {
  h.calls.length = 0;
  h.enqueue.mockReset().mockResolvedValue({ id: "meta-attach-msg_1" });
  h.wait.mockReset().mockResolvedValue("sent");
  h.publish.mockReset();
  h.graph.mockReset();
});

describe("POST /attachments (canal Meta)", () => {
  it("201 com a mensagem pending, job enfileirado e sem esperar a Meta", async () => {
    const res = await POST(uploadRequest(), ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: Record<string, unknown> };
    expect(body.message).toMatchObject({
      id: "msg_1",
      sendStatus: "pending",
      status: "PENDING",
      mediaUrl: "/api/storage/org_1/attachments/att-1.png",
      messageType: "image",
    });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv_1",
        messageId: "msg_1",
        organizationId: "org_1",
        kind: "image",
      }),
    );
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.graph).not.toHaveBeenCalled();
    // A bolha entra no chat na hora (não espera o worker).
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("acesso e conversa numa leitura só", async () => {
    await POST(uploadRequest(), ctx);
    expect(h.calls.filter((c) => c.startsWith("conversation.find"))).toEqual([
      "conversation.findFirst",
    ]);
  });

  it("Server-Timing traz as fases da requisição", async () => {
    const res = await POST(uploadRequest(), ctx);
    const header = res.headers.get("server-timing") ?? "";
    for (const phase of ["auth", "access", "body", "channel", "store", "db", "queue", "total"]) {
      expect(header).toMatch(new RegExp(`(^|, )${phase};dur=`));
    }
    expect(header).not.toMatch(/wait;dur=/);
  });

  it("fila indisponível: mensagem vira failed e a resposta traz metaError", async () => {
    h.enqueue.mockResolvedValueOnce(null);
    const res = await POST(uploadRequest(), ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: Record<string, unknown>; metaError?: string };
    expect(body.message).toMatchObject({ sendStatus: "failed", status: "FAILED" });
    expect(body.metaError).toMatch(/Fila de envio indisponível/);
    expect(h.calls).toContain("message.updateMany");
    expect(h.graph).not.toHaveBeenCalled();
  });

  it("waitUntilSent só quando o cliente pede (sequência de modelo/produto)", async () => {
    const plain = await POST(reuseRequest(), ctx);
    expect(plain.status).toBe(201);
    expect(h.wait).not.toHaveBeenCalled();

    const waited = await POST(reuseRequest({ waitUntilSent: true }), ctx);
    expect(h.wait).toHaveBeenCalledWith("msg_1");
    const body = (await waited.json()) as { message: Record<string, unknown> };
    expect(body.message).toMatchObject({ sendStatus: "sent", status: "SENT" });
    expect(waited.headers.get("server-timing")).toMatch(/wait;dur=/);
    expect(h.graph).not.toHaveBeenCalled();
  });
});

describe("enqueueMetaAttach — idempotência", () => {
  it("jobId = meta-attach-<messageId> (retentativa do produtor não duplica)", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/queue");
    vi.doMock("ioredis", () => ({ default: class {} }));
    vi.doMock("bullmq", () => ({
      Queue: class {
        add = h.queueAdd;
      },
    }));
    h.queueAdd.mockResolvedValue({ id: "meta-attach-msg_9" });
    const { enqueueMetaAttach } = await import("@/lib/queue");
    const payload = {
      conversationId: "conv_1",
      messageId: "msg_9",
      organizationId: "org_1",
      originalName: "foto.png",
      mime: "image/png",
      caption: "",
      kind: "image" as const,
    };
    await enqueueMetaAttach(payload);
    await enqueueMetaAttach(payload);
    expect(h.queueAdd).toHaveBeenCalledTimes(2);
    for (const call of h.queueAdd.mock.calls) {
      expect(call[0]).toBe("process");
      expect(call[2]).toMatchObject({ jobId: "meta-attach-msg_9" });
    }
  });
});
