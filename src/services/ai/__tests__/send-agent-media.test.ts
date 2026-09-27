import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  read: vi.fn(),
  upload: vi.fn(),
  process: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/audio-convert", () => ({ WHATSAPP_VIDEO_MAX_BYTES: 16 * 1024 * 1024 }));
vi.mock("@/lib/queue", () => ({ enqueueMetaAttach: mocks.enqueue }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "m-1", createdAt: new Date("2026-01-01T10:00:00Z") })),
      updateMany: mocks.updateMany,
    },
    conversation: {
      findUnique: vi.fn(async () => ({
        id: "conv-1",
        organizationId: "org-1",
        channelId: "ch-1",
        waJid: null,
        channelRef: { id: "ch-1", config: {}, provider: "META" },
      })),
    },
    user: { findUnique: vi.fn(async () => ({ name: "Agente" })) },
  },
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/lib/send-whatsapp", () => ({ isBaileysChannel: () => false, sendWhatsAppMedia: vi.fn() }));
vi.mock("@/lib/storage/local", () => ({
  parseStoragePath: () => ({ orgId: "org-1", bucket: "attachments", fileName: "guia.mp4" }),
  resolveOutboundAttachmentMime: (o: { rawType?: string }) => o.rawType || "application/octet-stream",
}));
vi.mock("@/lib/storage/read-for-send", () => ({
  isOrgOwnedStorageUrl: () => true,
  isStorageUrlOfOrg: (url: string, org: string) => url.includes(`/${org}/`),
  readStoredMediaForSend: mocks.read,
}));
vi.mock("@/lib/meta-whatsapp/client", () => ({ metaClientFromConfig: () => ({ configured: true, uploadMedia: mocks.upload }) }));
vi.mock("@/jobs/whatsapp/meta-attach.job", () => ({ processMetaAttach: mocks.process }));

import { mediaNotSentTrace, sendAgentFollowUpMedia, type MediaSendReport } from "../send-agent-media";

const VIDEO = { url: "/api/storage/org-1/attachments/guia.mp4", mimeType: "video/mp4", name: "guia.mp4" };
const AUDIO = { url: "/api/storage/org-1/attachments/guia.mp3", mimeType: "audio/mpeg", name: "guia.mp3" };

function send(att = VIDEO) {
  return sendAgentFollowUpMedia({ conversationId: "conv-1", contactId: "c-1", agentUserId: "u-1", attachments: [att] });
}

describe("anexo guardado em outra organização", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não sai, não cria mensagem e o motivo vai para o rastro", async () => {
    let report: MediaSendReport | undefined;
    const other = { url: "/api/storage/org-2/attachments/tutorial.mp4", mimeType: "video/mp4", name: "tutorial.mp4" };
    const sent = await sendAgentFollowUpMedia({
      conversationId: "conv-1",
      contactId: "c-1",
      agentUserId: "u-1",
      attachments: [other],
      report: (r) => {
        report = r;
      },
    });
    expect(sent).toBe(0);
    const { prisma } = await import("@/lib/prisma");
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(report).toEqual({ otherOrg: ["tutorial.mp4"], alreadySent: [] });
    expect(mediaNotSentTrace("Anexos", report)).toContain("outra organização");
  });

  it("rastro diferencia trava de repetição e falta de canal", () => {
    expect(mediaNotSentTrace("Anexos", { otherOrg: [], alreadySent: ["guia.mp4"] })).toContain("trava de repetição");
    expect(mediaNotSentTrace("Anexos", { otherOrg: [], alreadySent: [] })).toContain("não tem canal");
  });
});

describe("anexo do agente pelo canal Meta — upload onde o arquivo existe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueue.mockResolvedValue({ id: "job-1" });
    mocks.read.mockResolvedValue({ buffer: Buffer.from("video"), size: 5, mimeType: "video/mp4", fileName: "guia.mp4", source: "local" });
    mocks.upload.mockResolvedValue("media-123");
  });

  it("sobe o arquivo para a Meta na API e manda o id no job", async () => {
    await expect(send()).resolves.toBe(1);
    expect(mocks.upload).toHaveBeenCalledWith(expect.any(Buffer), "video/mp4", "guia.mp4");
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m-1", kind: "video", mediaId: "media-123" }));
  });

  it("upload falhou: o job vai sem id e tenta com o arquivo, como antes", async () => {
    mocks.upload.mockRejectedValue(new Error("Meta indisponível"));
    await expect(send()).resolves.toBe(1);
    const payload = mocks.enqueue.mock.calls[0][0];
    expect(payload.mediaId).toBeUndefined();
  });

  it("áudio não sobe aqui (a conversão é no worker)", async () => {
    await expect(send(AUDIO)).resolves.toBe(1);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.enqueue.mock.calls[0][0].mediaId).toBeUndefined();
  });

  it("fila indisponível com o id na mão: envia daqui mesmo", async () => {
    mocks.enqueue.mockResolvedValue(null);
    mocks.process.mockResolvedValue({ sendStatus: "sent", externalId: "wamid" });
    await expect(send()).resolves.toBe(1);
    expect(mocks.process).toHaveBeenCalledWith(expect.objectContaining({ mediaId: "media-123" }));
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("envio que falhou não conta como 'já enviado'", async () => {
    await send();
    const { prisma } = await import("@/lib/prisma");
    const where = (prisma.message.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.sendStatus).toEqual({ not: "failed" });
  });

  it("reenvio a pedido do cliente ignora a trava de repetição", async () => {
    const { prisma } = await import("@/lib/prisma");
    await sendAgentFollowUpMedia({ conversationId: "conv-1", contactId: "c-1", agentUserId: "u-1", attachments: [VIDEO], ignoreRecent: true });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
