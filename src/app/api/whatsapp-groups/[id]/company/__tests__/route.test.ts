import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ findConnectedBaileysChannel: vi.fn(), setWhatsAppGroupCompany: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (h: (s: unknown) => unknown) => h({ user: { id: "u1" } }),
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/services/whatsapp-groups", () => svc);

import { PUT } from "../route";

const ctx = { params: Promise.resolve({ id: "g1" }) };
const put = (body: unknown) =>
  PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx);

describe("PUT /api/whatsapp-groups/:id/company", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1" });
  });

  it("vincula a empresa", async () => {
    svc.setWhatsAppGroupCompany.mockResolvedValue({ company: { id: "c1", number: 4, name: "5RS Sucata" } });
    const res = await put({ companyId: "c1" });
    expect(res.status).toBe(200);
    expect(svc.setWhatsAppGroupCompany).toHaveBeenCalledWith({ groupId: "g1", channelId: "ch1", companyId: "c1" });
    expect((await res.json()).company.name).toBe("5RS Sucata");
  });

  it("desvincula com null", async () => {
    svc.setWhatsAppGroupCompany.mockResolvedValue({ company: null });
    await put({ companyId: null });
    expect(svc.setWhatsAppGroupCompany).toHaveBeenCalledWith({ groupId: "g1", channelId: "ch1", companyId: null });
  });

  it("corpo inválido: 400; empresa de outra org: 404", async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ companyId: "" })).status).toBe(400);
    svc.setWhatsAppGroupCompany.mockResolvedValue({ error: "Empresa não encontrada.", status: 404 });
    expect((await put({ companyId: "outra" })).status).toBe(404);
  });
});
