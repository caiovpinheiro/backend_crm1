import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  findConnectedBaileysChannel: vi.fn(),
  markWhatsAppGroupRead: vi.fn(),
}));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (h: (s: unknown) => unknown) => h({ user: { id: "u1" } }),
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/services/whatsapp-groups", () => svc);

import { POST } from "../route";

const ctx = { params: Promise.resolve({ id: "g1" }) };

describe("POST /api/whatsapp-groups/:id/read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marca como visto no número conectado", async () => {
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1" });
    const res = await POST(new Request("http://x", { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect(svc.markWhatsAppGroupRead).toHaveBeenCalledWith("g1", "ch1");
  });

  it("sem número QR conectado: 409 e nada muda", async () => {
    svc.findConnectedBaileysChannel.mockResolvedValue(null);
    const res = await POST(new Request("http://x", { method: "POST" }), ctx);
    expect(res.status).toBe(409);
    expect(svc.markWhatsAppGroupRead).not.toHaveBeenCalled();
  });
});
