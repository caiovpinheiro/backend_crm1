/**
 * POST/DELETE eligibility: exige distribution:manage, valida o corpo e usa
 * o usuário da sessão como autor.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  denied: null as unknown,
  set: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (fn: (s: { user: { id: string; organizationId: string; isSuperAdmin: boolean } }) => unknown) =>
    fn({ user: { id: "gestor-1", organizationId: "org-1", isSuperAdmin: false } }),
}));
vi.mock("@/app/api/distribution/leads/department-rules/_guard", () => ({
  guardLeadsDepartmentRules: async () => h.denied,
}));
vi.mock("@/services/distribution/leads/eligibility-overrides", () => ({
  setLeadsEligibilityOverride: h.set,
  endLeadsEligibilityOverride: h.end,
}));

import { DELETE, POST } from "./route";

const ctx = { params: Promise.resolve({ userId: "consultor-1" }) };
const post = (body: unknown) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  h.denied = null;
  h.set.mockResolvedValue({
    ok: true,
    override: {
      userId: "consultor-1",
      eligible: true,
      startsAt: new Date("2026-11-05T20:00:00Z"),
      endsAt: new Date("2026-11-06T01:00:00Z"),
    },
  });
  h.end.mockResolvedValue(true);
});

describe("eligibility route", () => {
  it("libera até HH:MM com o gestor da sessão como autor", async () => {
    const res = await post({ eligible: true, until: "22:00" });
    expect(res.status).toBe(201);
    expect(h.set).toHaveBeenCalledWith({
      userId: "consultor-1",
      eligible: true,
      until: "22:00",
      createdById: "gestor-1",
    });
  });

  it("corpo inválido: 400 sem gravar", async () => {
    expect((await post({ eligible: "sim" })).status).toBe(400);
    expect(h.set).not.toHaveBeenCalled();
  });

  it("sem distribution:manage: devolve a recusa do guard", async () => {
    h.denied = NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    expect((await post({ eligible: true, until: "22:00" })).status).toBe(403);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx)).status).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.end).not.toHaveBeenCalled();
  });

  it("encerrar agora", async () => {
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), ctx);
    expect(await res.json()).toEqual({ ok: true, ended: true });
  });
});
