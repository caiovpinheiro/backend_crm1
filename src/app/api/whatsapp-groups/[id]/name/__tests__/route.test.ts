import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ findConnectedBaileysChannel: vi.fn(), setWhatsAppGroupCustomName: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (h: (s: unknown) => unknown) => h({ user: { id: "u1" } }),
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/services/whatsapp-groups", () => svc);

import { PUT } from "../route";

const ctx = { params: Promise.resolve({ id: "g1" }) };
const put = (body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx);

describe("PUT /api/whatsapp-groups/:id/name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1" });
  });

  it("define o apelido", async () => {
    svc.setWhatsAppGroupCustomName.mockResolvedValue({ customName: "Confiança - RH" });
    const res = await put({ customName: "Confiança - RH" });
    expect(res.status).toBe(200);
    expect(svc.setWhatsAppGroupCustomName).toHaveBeenCalledWith({
      groupId: "g1",
      channelId: "ch1",
      customName: "Confiança - RH",
    });
    expect((await res.json()).customName).toBe("Confiança - RH");
  });

  it("apaga com null", async () => {
    svc.setWhatsAppGroupCustomName.mockResolvedValue({ customName: null });
    expect((await put({ customName: null })).status).toBe(200);
    expect(svc.setWhatsAppGroupCustomName).toHaveBeenCalledWith({ groupId: "g1", channelId: "ch1", customName: null });
  });

  it("corpo inválido: 400; sem WhatsApp conectado: 409", async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ customName: 5 })).status).toBe(400);
    svc.findConnectedBaileysChannel.mockResolvedValue(null);
    expect((await put({ customName: "x" })).status).toBe(409);
    expect(svc.setWhatsAppGroupCustomName).not.toHaveBeenCalled();
  });
});
