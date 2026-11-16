import { beforeEach, describe, expect, it, vi } from "vitest";

const deals = vi.hoisted(() => ({ getDealById: vi.fn(), createDealEvent: vi.fn() }));
const svc = vi.hoisted(() => {
  class DealCompanyError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }
  return {
    DealCompanyError,
    linkDealCompany: vi.fn(),
    listDealCompanies: vi.fn(),
    setPrimaryDealCompany: vi.fn(),
    unlinkDealCompany: vi.fn(),
  };
});
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (h: (s: unknown) => unknown) => h({ user: { id: "u1" } }),
}));
vi.mock("@/services/deals", () => deals);
vi.mock("@/services/deal-companies", () => svc);

import { GET, POST } from "../route";
import { DELETE, PATCH } from "../[companyId]/route";

const ctx = { params: Promise.resolve({ id: "d1" }) };
const ctx2 = { params: Promise.resolve({ id: "d1", companyId: "c1" }) };
const json = (method: string, body: unknown) =>
  new Request("http://x", { method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  deals.getDealById.mockResolvedValue({ id: "d1" });
  deals.createDealEvent.mockResolvedValue(undefined);
  svc.listDealCompanies.mockResolvedValue([{ companyId: "c1", isPrimary: true }]);
});

describe("/api/deals/:id/companies", () => {
  it("GET lista; negócio de fora: 404", async () => {
    expect((await (await GET(new Request("http://x"), ctx)).json()).items).toHaveLength(1);
    deals.getDealById.mockResolvedValue(null);
    expect((await GET(new Request("http://x"), ctx)).status).toBe(404);
  });

  it("POST vincula e registra no histórico do negócio", async () => {
    svc.linkDealCompany.mockResolvedValue({ companyName: "Cacau Lopes", isPrimary: true });
    const res = await POST(json("POST", { companyId: "c1" }), ctx);
    expect(res.status).toBe(201);
    expect(svc.linkDealCompany).toHaveBeenCalledWith("d1", "c1", { primary: false });
    expect(deals.createDealEvent).toHaveBeenCalledWith("d1", "u1", "COMPANY_LINKED", {
      companyId: "c1",
      companyName: "Cacau Lopes",
      isPrimary: true,
    });
  });

  it("POST sem empresa: 400; já vinculada: 409", async () => {
    expect((await POST(json("POST", {}), ctx)).status).toBe(400);
    svc.linkDealCompany.mockRejectedValue(new svc.DealCompanyError("EMPRESA_JA_VINCULADA", "já"));
    expect((await POST(json("POST", { companyId: "c1" }), ctx)).status).toBe(409);
  });

  it("PATCH torna principal; DELETE desvincula", async () => {
    svc.setPrimaryDealCompany.mockResolvedValue({ companyName: "iad" });
    expect((await PATCH(json("PATCH", { isPrimary: true }), ctx2)).status).toBe(200);
    expect((await PATCH(json("PATCH", { isPrimary: false }), ctx2)).status).toBe(400);
    svc.unlinkDealCompany.mockResolvedValue({ companyName: "iad" });
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx2)).status).toBe(200);
    expect(deals.createDealEvent).toHaveBeenCalledWith("d1", "u1", "COMPANY_UNLINKED", { companyId: "c1", companyName: "iad" });
  });
});
