/**
 * POST /api/me/sessions/revoke-all — exige sessão, incrementa a versão do
 * usuário da sessão e devolve a versão nova; por padrão (`keepCurrent`)
 * devolve também a prova para ESTA sessão continuar (SV-2). Erro do banco
 * vira 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  revokeUserSessions: vi.fn(),
  issueSessionRenewal: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/auth/session-revocation", () => ({
  revokeUserSessions: mocks.revokeUserSessions,
}));
vi.mock("@/lib/auth/session-renewal", () => ({
  issueSessionRenewal: mocks.issueSessionRenewal,
}));

import { NextResponse } from "next/server";

import { POST } from "@/app/api/me/sessions/revoke-all/route";

const SESSION = {
  user: { id: "u1", organizationId: "org1", isSuperAdmin: false, sessionVersion: 1 },
};
const GRANT = { token: "t".repeat(43), sessionVersion: 2, expiresInSec: 60 };

function post(body?: unknown, raw?: string): Request {
  return new Request("https://api.test/api/me/sessions/revoke-all", {
    method: "POST",
    ...(body !== undefined || raw !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: raw ?? JSON.stringify(body),
        }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ ok: true, session: SESSION });
  mocks.revokeUserSessions.mockResolvedValue(2);
  mocks.issueSessionRenewal.mockResolvedValue(GRANT);
});

describe("POST /api/me/sessions/revoke-all", () => {
  it("sem sessão devolve a resposta do requireAuth", async () => {
    const denied = NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    mocks.requireAuth.mockResolvedValue({ ok: false, response: denied });
    const res = await POST(post());
    expect(res.status).toBe(401);
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
    expect(mocks.issueSessionRenewal).not.toHaveBeenCalled();
  });

  it("sem corpo (default manter): revoga e devolve a prova para a sessão atual", async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionVersion: 2, sessionRenewal: GRANT });
    expect(mocks.revokeUserSessions).toHaveBeenCalledWith({
      userId: "u1",
      organizationId: "org1",
      reason: "revoke_all",
    });
    // A prova liga o usuário, a versão nova e a claim de quem pediu.
    expect(mocks.issueSessionRenewal).toHaveBeenCalledWith({
      userId: "u1",
      newVersion: 2,
      tokenVersion: 1,
    });
  });

  it("keepCurrent: true explícito e corpo inválido se comportam como o default", async () => {
    for (const req of [post({ keepCurrent: true }), post(undefined, "{nao-json"), post({ keepCurrent: "sim" })]) {
      const res = await POST(req);
      expect((await res.json()).sessionRenewal).toEqual(GRANT);
    }
  });

  it("keepCurrent: false — derruba tudo, sem prova", async () => {
    const res = await POST(post({ keepCurrent: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionVersion: 2 });
    expect(mocks.revokeUserSessions).toHaveBeenCalledTimes(1);
    expect(mocks.issueSessionRenewal).not.toHaveBeenCalled();
  });

  it("prova não emitida (sessão que pediu já estava defasada): responde sem sessionRenewal", async () => {
    mocks.issueSessionRenewal.mockResolvedValue(null);
    const res = await POST(post());
    expect(await res.json()).toEqual({ ok: true, sessionVersion: 2 });
  });

  it("erro do banco → 500 sem vazar detalhe e sem prova", async () => {
    mocks.revokeUserSessions.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(post());
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("db down");
    expect(text).not.toContain("sessionRenewal");
    expect(mocks.issueSessionRenewal).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
