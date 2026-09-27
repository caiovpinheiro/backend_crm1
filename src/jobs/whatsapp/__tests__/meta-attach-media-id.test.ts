import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  readStoredFile: vi.fn(),
  uploadMedia: vi.fn(),
  sendMediaById: vi.fn(),
}));

vi.mock("@/lib/audio-convert", () => ({
  guessInputExt: () => "mp3",
  metaCloudAudioUploadBlocked: () => null,
  prepareWhatsAppAudio: vi.fn(),
  WHATSAPP_VIDEO_MAX_BYTES: 16 * 1024 * 1024,
  WHATSAPP_VIDEO_TOO_LARGE_MESSAGE: "Vídeo acima do limite.",
}));
vi.mock("@/lib/channels/config", () => ({ getDecryptedChannelConfig: () => ({}) }));
vi.mock("@/lib/meta-whatsapp/client", () => ({
  formatMetaSendError: (e: unknown) => String(e),
  metaClientFromConfig: () => ({ configured: true, uploadMedia: mocks.uploadMedia, sendMediaById: mocks.sendMediaById }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: { findUnique: mocks.findUnique, update: mocks.update, updateMany: mocks.updateMany },
    conversation: { update: vi.fn(async () => ({})) },
    channel: { findUnique: vi.fn(async () => ({ id: "ch-1", provider: "META", config: {} })) },
  },
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/lib/storage/local", () => ({
  mimeFromFilename: () => "video/mp4",
  parseStoragePath: () => ({ orgId: "org-1", bucket: "attachments", fileName: "guia.mp4" }),
  readLegacyUploadsFile: vi.fn(async () => null),
  readStoredFile: mocks.readStoredFile,
  resolveOutboundAttachmentMime: () => "video/mp4",
}));
vi.mock("@/lib/storage/read-for-send", () => ({ readStoredMediaForSend: vi.fn(async () => null) }));
vi.mock("@/services/activity-log", () => ({ logMessageFailed: vi.fn() }));
vi.mock("@/services/automation-triggers", () => ({ fireTrigger: vi.fn(async () => undefined) }));

import { processMetaAttach } from "../meta-attach.job";

const payload = {
  conversationId: "conv-1",
  messageId: "m-1",
  organizationId: "org-1",
  originalName: "guia.mp4",
  mime: "video/mp4",
  caption: "",
  kind: "video" as const,
};

describe("job de anexo Meta — arquivo já enviado pela API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "m-1",
      sendStatus: "pending",
      externalId: null,
      mediaUrl: "/api/storage/org-1/attachments/guia.mp4",
      messageType: "video",
      channelId: "ch-1",
      conversationId: "conv-1",
      conversation: { id: "conv-1", contactId: "c-1", channelId: "ch-1", organizationId: "org-1", contact: { phone: "5511999990000", whatsappBsuid: null } },
    });
    mocks.readStoredFile.mockResolvedValue(null);
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.sendMediaById.mockResolvedValue({ messages: [{ id: "wamid-1" }] });
  });

  it("com o id, envia sem ler o arquivo nem subir de novo", async () => {
    const res = await processMetaAttach({ ...payload, mediaId: "media-123" });
    expect(res.sendStatus).toBe("sent");
    expect(res.externalId).toBe("wamid-1");
    expect(mocks.readStoredFile).not.toHaveBeenCalled();
    expect(mocks.uploadMedia).not.toHaveBeenCalled();
    expect(mocks.sendMediaById).toHaveBeenCalledWith("5511999990000", "media-123", "video", undefined, undefined, false, undefined);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sendStatus: "sent", externalId: "wamid-1" }) }));
  });

  it("sem o id e sem o arquivo neste processo: falha como antes", async () => {
    const res = await processMetaAttach(payload);
    expect(res.sendStatus).toBe("failed");
    expect(res.metaError).toBe("Arquivo não encontrado no storage — envie o arquivo de novo.");
    expect(mocks.sendMediaById).not.toHaveBeenCalled();
  });

  it("áudio ignora o id: precisa do arquivo para converter", async () => {
    const res = await processMetaAttach({ ...payload, kind: "audio", mime: "audio/mpeg", mediaId: "media-123" });
    expect(res.sendStatus).toBe("failed");
    expect(mocks.readStoredFile).toHaveBeenCalled();
    expect(mocks.sendMediaById).not.toHaveBeenCalled();
  });
});
