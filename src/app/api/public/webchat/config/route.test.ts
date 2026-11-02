import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ channel: null as Record<string, unknown> | null }));

vi.mock("@/lib/webchat/session", () => ({
  loadWebchatChannelByKey: vi.fn(async () => h.channel),
  checkWebchatOrigin: () => true,
  originDenied: () => new Response(null, { status: 403 }),
  webchatError: (status: number) => new Response(null, { status }),
}));
vi.mock("@/lib/webchat/http", () => ({
  getClientIp: () => "1.1.1.1",
  webchatRateLimit: vi.fn(async () => ({ ok: true, headers: {} })),
}));
vi.mock("@/lib/webchat/online", () => ({ isWebchatOnline: vi.fn(async () => true) }));

import { GET } from "./route";

async function themeOf(own: string | undefined, org: string | null) {
  h.channel = {
    organizationId: "org_a",
    publicKey: "wc_chave",
    name: "Canal",
    config: { theme: { position: "right", title: "x", ...(own ? { avatarUrl: own } : {}) } },
    v2: { appearance: { model: "compact" } },
    orgDefaults: { primary: "#000000", avatarUrl: org },
  };
  const res = await GET(new Request("http://crm.test/api/public/webchat/config?key=wc_chave"));
  return ((await res.json()) as { theme: { avatarUrl: string | null } }).theme;
}

beforeEach(() => {
  h.channel = null;
});

describe("GET /api/public/webchat/config — avatar", () => {
  it("canal sem logo própria herda a da organização pela rota pública", async () => {
    const theme = await themeOf(undefined, "/api/storage/org_a/branding/org.png");
    expect(theme.avatarUrl).toMatch(/^\/api\/public\/webchat\/logo\?key=wc_chave&v=/);
    expect(JSON.stringify(theme)).not.toContain("/api/storage/");
  });

  it("logo enviada ao canal vale mais que a da organização", async () => {
    const a = await themeOf("/api/storage/org_a/branding/canal.png", "/api/storage/org_a/branding/org.png");
    const b = await themeOf(undefined, "/api/storage/org_a/branding/org.png");
    expect(a.avatarUrl).not.toBe(b.avatarUrl);
  });

  it("URL https manual continua como está", async () => {
    expect((await themeOf("https://cdn.test/a.png", null)).avatarUrl).toBe("https://cdn.test/a.png");
  });

  it("caminho do storage de outro bucket não chega ao visitante", async () => {
    expect((await themeOf(undefined, "/api/storage/org_a/attachments/a.png")).avatarUrl).toBeNull();
  });
});
