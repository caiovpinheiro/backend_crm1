import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  findConnectedBaileysChannel: vi.fn(),
  getWhatsAppGroup: vi.fn(),
  appendWhatsAppGroupMessage: vi.fn(),
}));
const queue = vi.hoisted(() => ({ enqueueBaileysOutbound: vi.fn() }));
const storage = vi.hoisted(() => ({ saveFile: vi.fn() }));

const ctxOrg = vi.hoisted(() => ({ value: "org1" as string | null }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ ok: true, session: { user: { id: "u1", name: "Ana" } } }),
  // Como o real: o handler roda dentro do contexto da org (runWithContext).
  withOrgContext: async (h: (s: unknown) => unknown) => {
    ctxOrg.value = "org1";
    try {
      return await h({ user: { id: "u1", name: "Ana" } });
    } finally {
      ctxOrg.value = null;
    }
  },
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => {
    if (!ctxOrg.value) throw new Error("getOrgIdOrThrow: organization context ausente");
    return ctxOrg.value;
  },
  getRequestContext: () => undefined,
}));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/services/whatsapp-groups", () => svc);
vi.mock("@/lib/storage/local", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/local")>()),
  saveFile: storage.saveFile,
}));

import { POST } from "../route";
import { groupAttachmentMessageType, groupAttachmentText } from "@/lib/whatsapp-group-attachment";

const ctx = { params: Promise.resolve({ id: "g1" }) };
const PDF = Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n");
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);

function upload(bytes: Buffer | null, name: string, type: string, caption?: string) {
  const form = new FormData();
  if (bytes) form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  if (caption) form.append("caption", caption);
  return POST(new Request("http://x", { method: "POST", body: form }), ctx);
}

describe("POST /api/whatsapp-groups/:id/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1", phoneNumber: "5511978398715" });
    svc.getWhatsAppGroup.mockResolvedValue({ id: "g1", jid: "1@g.us" });
    svc.appendWhatsAppGroupMessage.mockImplementation(async (m: Record<string, unknown>) => ({ id: "m1", ...m }));
    queue.enqueueBaileysOutbound.mockResolvedValue({ id: "job1" });
    storage.saveFile.mockImplementation(async ({ fileName }: { fileName: string }) => ({
      url: `/api/storage/org1/attachments/${fileName}`,
    }));
  });

  it("sem arquivo: 400", async () => {
    const res = await upload(null, "x", "text/plain");
    expect(res.status).toBe(400);
    expect(queue.enqueueBaileysOutbound).not.toHaveBeenCalled();
  });

  it("documento: guarda, envia com o nome do arquivo e grava no histórico", async () => {
    const res = await upload(PDF, "proposta.pdf", "application/pdf");
    expect(res.status).toBe(200);
    expect(storage.saveFile).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org1", bucket: "attachments" }));
    expect(queue.enqueueBaileysOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ to: "1@g.us", messageType: "document", content: "proposta.pdf", mime: "application/pdf" }),
    );
    expect(svc.appendWhatsAppGroupMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "document", fileName: "proposta.pdf", text: "📎 proposta.pdf", fromMe: true }),
    );
  });

  it("áudio gravado no navegador (webm) sai como voz", async () => {
    const res = await upload(WEBM, "audio-1.webm", "audio/webm");
    expect(res.status).toBe(200);
    expect(queue.enqueueBaileysOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ messageType: "ptt", originalName: "audio-1.webm", content: "" }),
    );
  });

  it("conteúdo não reconhecido: 415 e nada sai", async () => {
    const res = await upload(Buffer.from("MZ\x90\x00binario"), "virus.exe", "application/octet-stream");
    expect(res.status).toBe(415);
    expect(queue.enqueueBaileysOutbound).not.toHaveBeenCalled();
  });

  it("falha ao gravar histórico não vira 500", async () => {
    svc.appendWhatsAppGroupMessage.mockRejectedValue(new Error("db"));
    const res = await upload(PDF, "a.pdf", "application/pdf");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, message: null });
  });
});

describe("rótulos do anexo", () => {
  it("tipo e texto como no inbox", () => {
    expect(groupAttachmentMessageType("audio/ogg")).toBe("ptt");
    expect(groupAttachmentMessageType("audio/mpeg")).toBe("audio");
    expect(groupAttachmentMessageType("image/png")).toBe("image");
    expect(groupAttachmentText("ptt", "a.webm", "")).toBe("[áudio]");
    expect(groupAttachmentText("image", "foto.png", " olha ")).toBe("olha");
    expect(groupAttachmentText("document", "a.pdf", "segue")).toBe("segue\n📎 a.pdf");
  });
});
