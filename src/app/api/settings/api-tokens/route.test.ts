/**
 * SEC-18 — tokens `eduit_` exigem `api_token:manage`; `expiresAt` segue
 * opcional (ausente → sem expiração), inválido/passado → 400, e a resposta
 * devolve `expiresAt` (ISO ou null).
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, requirePermission, generateToken, listTokens, revokeToken } = vi.hoisted(() => ({
  auth: vi.fn(),
  requirePermission: vi.fn(),
  generateToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/authz", () => ({ requirePermission }));
vi.mock("@/services/api-tokens", () => ({ generateToken, listTokens, revokeToken }));

import { DELETE } from "./[id]/route";
import { GET, POST } from "./route";

const DENIED = () =>
  NextResponse.json({ message: "Acesso negado.", required: "api_token:manage" }, { status: 403 });

function post(body: unknown): Request {
  return new Request("http://localhost/api/settings/api-tokens", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("/api/settings/api-tokens — permissão api_token:manage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { id: "u1", organizationId: "org1", isSuperAdmin: false } });
    listTokens.mockResolvedValue([]);
    generateToken.mockResolvedValue({
      id: "tok1",
      token: "eduit_x",
      prefix: "eduit_x",
      expiresAt: null,
    });
    revokeToken.mockResolvedValue({ count: 1 });
  });

  it("GET 403 sem a permissão", async () => {
    requirePermission.mockResolvedValue(DENIED());
    const res = await GET();
    expect(res.status).toBe(403);
    expect(requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1", organizationId: "org1" }),
      "api_token:manage",
    );
    expect(listTokens).not.toHaveBeenCalled();
  });

  it("POST 403 sem a permissão (não cria token)", async () => {
    requirePermission.mockResolvedValue(DENIED());
    const res = await POST(post({ name: "n8n" }));
    expect(res.status).toBe(403);
    expect(generateToken).not.toHaveBeenCalled();
  });

  it("DELETE 403 sem a permissão", async () => {
    requirePermission.mockResolvedValue(DENIED());
    const res = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: "tok1" }),
    });
    expect(res.status).toBe(403);
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it("POST sem expiresAt → serviço recebe null (sem expiração) e resposta traz expiresAt null", async () => {
    requirePermission.mockResolvedValue(null);
    const res = await POST(post({ name: "n8n" }));
    expect(res.status).toBe(201);
    expect(generateToken).toHaveBeenCalledWith("u1", "org1", "n8n", null);
    const data = (await res.json()) as { expiresAt: string | null; token: string };
    expect(data.expiresAt).toBeNull();
    expect(data.token).toBe("eduit_x");
  });

  it("POST com expiresAt futuro → repassa a data e resposta traz ISO", async () => {
    requirePermission.mockResolvedValue(null);
    const future = new Date("2027-01-15T12:00:00Z");
    generateToken.mockResolvedValue({ id: "tok1", token: "eduit_x", prefix: "eduit_x", expiresAt: future });
    const res = await POST(post({ name: "n8n", expiresAt: future.toISOString() }));
    expect(res.status).toBe(201);
    expect(generateToken).toHaveBeenCalledWith("u1", "org1", "n8n", future);
    const data = (await res.json()) as { expiresAt: string | null };
    expect(data.expiresAt).toBe("2027-01-15T12:00:00.000Z");
  });

  it("POST com expiresAt no passado → 400", async () => {
    requirePermission.mockResolvedValue(null);
    const res = await POST(post({ name: "n8n", expiresAt: "2020-01-01T00:00:00Z" }));
    expect(res.status).toBe(400);
    expect(generateToken).not.toHaveBeenCalled();
  });

  it("401 sem sessão", async () => {
    auth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(requirePermission).not.toHaveBeenCalled();
  });
});
