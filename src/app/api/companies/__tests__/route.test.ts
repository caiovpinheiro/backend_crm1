import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ createCompany: vi.fn(), getCompanies: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: async () => ({ ok: true, user: { id: "u1", organizationId: "o1" } }),
  runWithApiUserContext: async (_u: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/services/companies", async (orig) => {
  const real = await orig<typeof import("@/services/companies")>();
  return { ...real, ...svc };
});

import { CompanyNumberConflictError } from "@/services/companies";
import { POST } from "../route";

const post = (body: unknown) =>
  POST(new Request("http://x/api/companies", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/companies — número da empresa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.createCompany.mockImplementation(async (d) => ({ id: "c1", number: d.number ?? 3, ...d }));
  });

  it("sem number → geração automática (number null para o serviço)", async () => {
    const res = await post({ name: "Acme" });
    expect(res.status).toBe(201);
    expect(svc.createCompany.mock.calls[0]![0].number).toBeNull();
  });

  it("number manual válido é repassado como está", async () => {
    const res = await post({ name: "Acme", number: "1001" });
    expect(res.status).toBe(201);
    expect(svc.createCompany.mock.calls[0]![0].number).toBe(1001);
  });

  it("number inválido → 400 sem criar", async () => {
    for (const number of [0, -1, 2.5, "abc"]) {
      const res = await post({ name: "Acme", number });
      expect(res.status, String(number)).toBe(400);
    }
    expect(svc.createCompany).not.toHaveBeenCalled();
  });

  it("number em uso na org → 409 com mensagem clara", async () => {
    svc.createCompany.mockRejectedValue(new CompanyNumberConflictError(5));
    const res = await post({ name: "Acme", number: 5 });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.message).toBe("Já existe uma empresa com o número 5 nesta organização.");
    expect(json.field).toBe("number");
  });
});
