import { beforeEach, describe, expect, it, vi } from "vitest";

const groups = vi.hoisted(() => ({ findConnectedBaileysChannel: vi.fn(), getWhatsAppGroup: vi.fn() }));
const media = vi.hoisted(() => ({
  countGroupMedia: vi.fn(),
  listGroupLinks: vi.fn(),
  listGroupMediaItems: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (h: (s: unknown) => unknown) => h({ user: { id: "u1" } }),
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/services/whatsapp-groups", () => groups);
vi.mock("@/services/whatsapp-group-media", () => media);

import { GET } from "../route";

const ctx = { params: Promise.resolve({ id: "g1" }) };
const get = (qs: string) => GET(new Request(`http://x/api/whatsapp-groups/g1/media${qs}`), ctx);

describe("GET /api/whatsapp-groups/:id/media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groups.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1" });
    groups.getWhatsAppGroup.mockResolvedValue({ id: "g1" });
  });

  it("resumo: totais + 3 mais recentes", async () => {
    media.countGroupMedia.mockResolvedValue({ media: 7, docs: 3, links: 2 });
    media.listGroupMediaItems.mockResolvedValue([{ id: "m1" }]);
    const res = await get("");
    expect(await res.json()).toEqual({ counts: { media: 7, docs: 3, links: 2 }, recent: [{ id: "m1" }] });
    expect(media.listGroupMediaItems).toHaveBeenCalledWith("g1", "media", { limit: 3 });
  });

  it("aba de documentos com paginação por data", async () => {
    media.listGroupMediaItems.mockResolvedValue([]);
    await get("?kind=docs&before=2026-11-01T00:00:00.000Z");
    expect(media.listGroupMediaItems).toHaveBeenCalledWith("g1", "docs", {
      before: new Date("2026-11-01T00:00:00.000Z"),
    });
  });

  it("aba de links", async () => {
    media.listGroupLinks.mockResolvedValue([{ id: "m1:0", url: "https://x.com" }]);
    expect(await (await get("?kind=links")).json()).toEqual({ links: [{ id: "m1:0", url: "https://x.com" }] });
  });

  it("tipo ou data inválidos: 400; grupo de outro número: 404", async () => {
    expect((await get("?kind=audio")).status).toBe(400);
    expect((await get("?kind=media&before=ontem")).status).toBe(400);
    groups.getWhatsAppGroup.mockResolvedValue(null);
    expect((await get("?kind=media")).status).toBe(404);
  });
});
