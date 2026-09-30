/**
 * SEC2-3 — upload de anexo do Bwipo Chat decide o tipo pelos magic bytes:
 * extensão/Content-Type falsos e `application/octet-stream` são recusados;
 * a extensão gravada vem do MIME detectado.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveFile, findFirst } = vi.hoisted(() => ({
  saveFile: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (fn: (session: unknown) => unknown) =>
    fn({ user: { id: "u1", organizationId: "org1", isSuperAdmin: false } }),
}));
vi.mock("@/app/api/team-chat/_guard", () => ({
  denyUnless: async () => null,
  jsonError: (message: string, status: number) => NextResponse.json({ message }, { status }),
  viewerOf: () => ({ userId: "u1", organizationId: "org1", isSuperAdmin: false }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { teamChatMember: { findFirst } },
}));
vi.mock("@/lib/storage/local", () => ({
  generateFileName: ({ prefix, ext }: { prefix: string; ext: string }) => `${prefix}-1.${ext}`,
  saveFile,
}));
vi.mock("@/services/team-chat", () => ({
  isOwnedStorageUrl: () => true,
}));

import { POST } from "./route";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(1),
]);
const EXE = new Uint8Array([0x4d, 0x5a, ...new Array(64).fill(0)]);

function req(file: File): Request {
  const fd = new FormData();
  fd.set("file", file);
  return new Request("http://localhost/api/team-chat/rooms/r1/attachments", {
    method: "POST",
    body: fd,
  });
}

const ctx = { params: Promise.resolve({ id: "r1" }) };

describe("POST /api/team-chat/rooms/[id]/attachments — sniff de magic bytes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue({ id: "m1" });
    saveFile.mockImplementation(async ({ fileName }: { fileName: string }) => ({
      url: `/api/storage/org1/attachments/${fileName}`,
    }));
  });

  it("recusa HTML com extensão .png e Content-Type image/png (415)", async () => {
    const fake = new File(["<html><script>alert(1)</script></html>"], "foto.png", {
      type: "image/png",
    });
    const res = await POST(req(fake), ctx);
    expect(res.status).toBe(415);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("recusa binário desconhecido enviado como application/octet-stream (415)", async () => {
    const exe = new File([EXE], "relatorio.pdf", { type: "application/octet-stream" });
    const res = await POST(req(exe), ctx);
    expect(res.status).toBe(415);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("aceita PNG real mesmo com nome .exe; extensão gravada vem do conteúdo", async () => {
    const png = new File([PNG], "imagem.exe", { type: "application/octet-stream" });
    const res = await POST(req(png), ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { attachment: { mimeType: string; kind: string; url: string } };
    expect(data.attachment.mimeType).toBe("image/png");
    expect(data.attachment.kind).toBe("image");
    expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: "orbita-1.png" }));
  });

  it("texto simples continua aceito como text/plain", async () => {
    const txt = new File(["linha 1\nlinha 2\n"], "notas.txt", { type: "text/plain" });
    const res = await POST(req(txt), ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { attachment: { mimeType: string; kind: string } };
    expect(data.attachment.mimeType).toBe("text/plain");
    expect(data.attachment.kind).toBe("file");
  });
});
