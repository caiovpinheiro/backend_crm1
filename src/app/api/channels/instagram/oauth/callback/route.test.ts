/**
 * SEC-22 — o callback OAuth Instagram só faz `postMessage` para a origem
 * do app (nunca `"*"`); sem origem resolvível não notifica o opener.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveAppOriginForOrg, verifyState, handleCallback } = vi.hoisted(() => ({
  resolveAppOriginForOrg: vi.fn(),
  verifyState: vi.fn(),
  handleCallback: vi.fn(),
}));

vi.mock("@/lib/app-origin", () => ({ resolveAppOriginForOrg }));
vi.mock("@/lib/webhook-context", () => ({
  withSystemContext: (_orgId: string, fn: () => unknown) => fn(),
}));
vi.mock("@/services/channels-instagram-oauth", () => ({
  IgOAuthError: class IgOAuthError extends Error {
    status = 400;
  },
  verifyState,
  handleCallback,
}));

import { GET } from "./route";

function req(qs: string): Request {
  return new Request(`http://localhost/api/channels/instagram/oauth/callback?${qs}`);
}

describe("GET /api/channels/instagram/oauth/callback — targetOrigin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyState.mockReturnValue({ orgId: "org1" });
    handleCallback.mockResolvedValue({ channel: { id: "ch1" }, username: "acme" });
  });

  it("usa a origem do tenant como targetOrigin, nunca '*'", async () => {
    resolveAppOriginForOrg.mockResolvedValue("https://acme.bwipo.com");
    const res = await GET(req("code=abc&state=s1"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('postMessage(');
    expect(html).toContain('"https://acme.bwipo.com")');
    expect(html).not.toContain('"*"');
    expect(resolveAppOriginForOrg).toHaveBeenCalledWith("org1");
  });

  it("sem origem resolvível não chama postMessage", async () => {
    resolveAppOriginForOrg.mockResolvedValue(null);
    const res = await GET(req("code=abc&state=s1"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("postMessage");
    expect(html).toContain("window.close()");
  });

  it("erro antes do state (sem org) usa só a origem explícita", async () => {
    resolveAppOriginForOrg.mockResolvedValue("https://app.example.com");
    const res = await GET(req("error=access_denied"));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('"https://app.example.com")');
    expect(html).not.toContain('"*"');
    expect(resolveAppOriginForOrg).toHaveBeenCalledWith(null);
  });
});
