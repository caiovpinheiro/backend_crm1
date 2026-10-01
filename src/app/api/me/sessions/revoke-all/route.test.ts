/**
 * POST /api/me/sessions/revoke-all — exige sessão, incrementa a versão
 * do usuário da sessão e devolve a versão nova; erro do banco vira 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  revokeUserSessions: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/auth/session-revocation", () => ({
  revokeUserSessions: mocks.revokeUserSessions,
}));

import { NextResponse } from "next/server";

import { POST } from "@/app/api/me/sessions/revoke-all/route";

const SESSION = {
  user: { id: "u1", organizationId: "org1", isSuperAdmin: false, sessionVersion: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ ok: true, session: SESSION });
});

describe("POST /api/me/sessions/revoke-all", () => {
  it("sem sessão devolve a resposta do requireAuth", async () => {
    const denied = NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    mocks.requireAuth.mockResolvedValue({ ok: false, response: denied });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
  });

  it("revoga as sessões do próprio usuário e devolve a versão nova", async () => {
    mocks.revokeUserSessions.mockResolvedValue(2);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionVersion: 2 });
    expect(mocks.revokeUserSessions).toHaveBeenCalledWith({
      userId: "u1",
      organizationId: "org1",
      reason: "revoke_all",
    });
  });

  it("erro do banco → 500 sem vazar detalhe", async () => {
    mocks.revokeUserSessions.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
    err.mockRestore();
  });
});
