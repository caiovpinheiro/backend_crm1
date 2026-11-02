/**
 * Visitante sem login vê a logo em uso no canal, e nada além dela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const h = vi.hoisted(() => ({
  channel: null as Record<string, unknown> | null,
  files: new Map<string, Buffer>(),
  limited: false,
  read: vi.fn(),
}));

vi.mock("@/lib/webchat/session", () => ({
  loadWebchatChannelByKey: vi.fn(async () => h.channel),
  webchatError: (status: number, code: string, message: string) =>
    Response.json({ code, message }, { status }),
}));
vi.mock("@/lib/webchat/http", () => ({
  getClientIp: () => "1.1.1.1",
  webchatRateLimit: vi.fn(async () =>
    h.limited
      ? { ok: false, response: new Response(null, { status: 429 }) }
      : { ok: true, headers: {} },
  ),
}));
vi.mock("@/lib/storage/local", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/local")>()),
  readStoredFile: h.read,
}));

import { GET } from "./route";

const call = (qs = "?key=wc_chave") => GET(new Request(`http://crm.test/api/public/webchat/logo${qs}`));

function setChannel(own: string | undefined, org: string | null = null) {
  h.channel = {
    organizationId: "org_a",
    publicKey: "wc_chave",
    config: { theme: { position: "right", title: "x", ...(own ? { avatarUrl: own } : {}) } },
    orgDefaults: { primary: "#000000", avatarUrl: org },
  };
}

beforeEach(() => {
  h.limited = false;
  h.files.clear();
  h.read.mockReset();
  h.read.mockImplementation(async (org: string, bucket: string, name: string) => {
    const buffer = h.files.get(`${org}/${bucket}/${name}`);
    return buffer ? { buffer, mimeType: "application/octet-stream", size: buffer.length } : null;
  });
  setChannel(undefined);
});

describe("GET /api/public/webchat/logo", () => {
  it("serve a logo própria do canal, sem sessão e embutível em outro domínio", async () => {
    h.files.set("org_a/branding/canal.png", PNG);
    setChannel("/api/storage/org_a/branding/canal.png", "/api/storage/org_a/branding/org.png");
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("canal sem logo própria herda a da organização", async () => {
    h.files.set("org_a/branding/org.png", PNG);
    setChannel(undefined, "/api/storage/org_a/branding/org.png");
    expect((await call()).status).toBe(200);
    expect(h.read).toHaveBeenCalledWith("org_a", "branding", "org.png");
  });

  it("o cliente não escolhe o arquivo", async () => {
    h.files.set("org_a/branding/org.png", PNG);
    setChannel(undefined, "/api/storage/org_a/branding/org.png");
    await call("?key=wc_chave&file=../attachments/contrato.pdf&path=org_b/keeps/a.png&v=x");
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith("org_a", "branding", "org.png");
  });

  it.each([
    ["outra organização", "/api/storage/org_b/branding/a.png"],
    ["outro bucket", "/api/storage/org_a/attachments/a.png"],
    ["URL externa", "https://cdn.test/a.png"],
  ])("%s: 404 sem ler o storage", async (_n, avatar) => {
    setChannel(undefined, avatar);
    expect((await call()).status).toBe(404);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("chave ausente ou desconhecida: 404", async () => {
    expect((await call("")).status).toBe(404);
    h.channel = null;
    expect((await call()).status).toBe(404);
  });

  it("canal sem logo e arquivo ausente: 404", async () => {
    expect((await call()).status).toBe(404);
    setChannel("/api/storage/org_a/branding/sumiu.png");
    expect((await call()).status).toBe(404);
  });

  it("arquivo que não é imagem não sai, mesmo com extensão de imagem", async () => {
    h.files.set("org_a/branding/falso.png", Buffer.from("<html><script>alert(1)</script></html>"));
    setChannel("/api/storage/org_a/branding/falso.png");
    expect((await call()).status).toBe(404);
  });

  it("respeita o limite por IP", async () => {
    h.limited = true;
    expect((await call()).status).toBe(429);
    expect(h.read).not.toHaveBeenCalled();
  });
});
