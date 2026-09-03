import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/safe-outbound-url", () => ({
  assertSafeOutboundUrl: vi.fn(async () => undefined),
}));

vi.mock("@/lib/storage/read-for-send", () => ({
  isOrgOwnedStorageUrl: vi.fn(() => false),
  readStoredMediaForSend: vi.fn(),
}));

import { resolveTemplateHeaderMediaParam } from "./template-header-media";

describe("resolveTemplateHeaderMediaParam", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("HTTPS público: baixa e envia { id } (não { link })", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      })),
    );

    const uploadMedia = vi.fn(async () => "meta-media-99");
    const client = { uploadMedia } as unknown as Parameters<
      typeof resolveTemplateHeaderMediaParam
    >[0];

    const param = await resolveTemplateHeaderMediaParam(
      client,
      "https://cdn.example.com/plano.png",
      "image",
    );

    expect(param).toEqual({ id: "meta-media-99" });
    expect(uploadMedia).toHaveBeenCalledOnce();
    const uploadArgs = uploadMedia.mock.calls[0] as unknown as [
      Buffer,
      string,
      string,
    ];
    expect(uploadArgs[1]).toBe("image/png");
  });

  it("rejeita Content-Type incompatível com IMAGE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
        },
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const client = {
      uploadMedia: vi.fn(),
    } as unknown as Parameters<typeof resolveTemplateHeaderMediaParam>[0];

    await expect(
      resolveTemplateHeaderMediaParam(
        client,
        "https://cdn.example.com/not-an-image",
        "image",
      ),
    ).rejects.toThrow(/Content-Type/i);
  });
});
