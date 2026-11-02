import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

const h = vi.hoisted(() => ({
  session: { user: { id: "u1", role: "ADMIN" } } as { user: { id: string; role: string } } | null,
  deny: false,
  channel: { provider: "WEBCHAT", organizationId: "org_a" } as Record<string, unknown> | null,
  save: vi.fn(async (o: { fileName: string }) => ({ url: `/x/${o.fileName}` })),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/authz/resource-policy", () => ({
  requireChannelScope: vi.fn(async (_u: unknown, action: string) =>
    h.deny || action !== "manage"
      ? NextResponse.json({ message: "Sem permissão." }, { status: 403 })
      : null,
  ),
}));
vi.mock("@/services/channels", () => ({ getChannelById: vi.fn(async () => h.channel) }));
vi.mock("@/lib/storage/local", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/local")>()),
  saveFile: h.save,
}));

import { WEBCHAT_STORED_LOGO_PATH } from "@/lib/webchat/config";

import { POST } from "./route";

const ctx = { params: Promise.resolve({ id: "ch-1" }) };

function post(bytes?: Buffer, name = "logo.png", type = "image/png") {
  const body = new FormData();
  if (bytes) body.append("file", new File([new Uint8Array(bytes)], name, { type }));
  return POST(new Request("http://crm.test/api/channels/ch-1/webchat-logo", { method: "POST", body }), ctx);
}

beforeEach(() => {
  h.session = { user: { id: "u1", role: "ADMIN" } };
  h.deny = false;
  h.channel = { provider: "WEBCHAT", organizationId: "org_a" };
  h.save.mockClear();
});

describe("POST /api/channels/:id/webchat-logo", () => {
  it("grava no branding da organização do canal e devolve um caminho que o canal aceita", async () => {
    const res = await post(PNG);
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/api\/storage\/org_a\/branding\/webchat_logo_.+\.png$/);
    expect(WEBCHAT_STORED_LOGO_PATH.test(url)).toBe(true);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org_a", bucket: "branding" }));
  });

  it("sem sessão: 401", async () => {
    h.session = null;
    expect((await post(PNG)).status).toBe(401);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("sem manage no canal: 403", async () => {
    h.deny = true;
    expect((await post(PNG)).status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("canal de outra organização (não encontrado) ou de outro tipo: 404", async () => {
    h.channel = null;
    expect((await post(PNG)).status).toBe(404);
    h.channel = { provider: "META_CLOUD_API", organizationId: "org_a" };
    expect((await post(PNG)).status).toBe(404);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("recusa SVG e arquivo que só finge ser imagem: 415", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await post(svg, "logo.svg", "image/svg+xml")).status).toBe(415);
    expect((await post(Buffer.from("isto nao e uma imagem"), "logo.png")).status).toBe(415);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("acima de 2 MB: 413", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await post(big)).status).toBe(413);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("sem arquivo: 400", async () => {
    expect((await post()).status).toBe(400);
  });
});
