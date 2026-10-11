/**
 * `authenticateApiRequest` (caminho por cookie): sessão revogada / expirada
 * por inatividade responde 401 `SESSION_REVOKED`; sem cookie segue o 401
 * "no_session" sem code; sessão válida passa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/api-access-audit", () => ({
  logApiAccessAuthReject: h.reject,
  logApiAccessCompleted: vi.fn(),
  resolveResponseStatus: () => 200,
}));
vi.mock("@/lib/api-public-access", () => ({
  bearerRequiresPublicApiMessage: () => "x",
  isBearerAllowedOnThisProcess: () => true,
}));
vi.mock("@/lib/metrics", () => ({ observeHttpRequest: vi.fn() }));
vi.mock("@/lib/org-rate-limit", () => ({ enforceOrgApiRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(),
  enforceSessionApiRateLimit: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/rate-limit-reject-log", () => ({ logRateLimitReject: vi.fn() }));
vi.mock("@/services/api-tokens", () => ({ validateToken: vi.fn().mockResolvedValue(null) }));

import { authenticateApiRequest } from "@/lib/api-auth";

const req = () => new Request("https://api.test/api/products");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateApiRequest — sessão revogada", () => {
  it("token marcado → 401 SESSION_REVOKED e log com o motivo", async () => {
    for (const reason of ["session_revoked", "idle_timeout"]) {
      h.auth.mockResolvedValue({ revoked: true, revokedReason: reason });
      const r = await authenticateApiRequest(req());
      if (r.ok) throw new Error("unreachable");
      expect(r.response.status).toBe(401);
      expect(await r.response.json()).toEqual({
        message: "Sessão expirada. Entre novamente.",
        code: "SESSION_REVOKED",
        // Inatividade leva `reason: "idle"`; os outros motivos, não.
        ...(reason === "idle_timeout" ? { reason: "idle" } : {}),
      });
      expect(h.reject).toHaveBeenLastCalledWith(expect.anything(), {
        reason,
        status: 401,
        via: "session",
      });
    }
  });

  it("sem cookie → 401 no_session sem code; sessão válida passa", async () => {
    h.auth.mockResolvedValue(null);
    const none = await authenticateApiRequest(req());
    if (none.ok) throw new Error("unreachable");
    expect(await none.response.json()).toEqual({ message: "Não autorizado." });

    h.auth.mockResolvedValue({ user: { id: "u1", organizationId: "o1", isSuperAdmin: false } });
    const ok = await authenticateApiRequest(req());
    expect(ok.ok).toBe(true);
  });
});
