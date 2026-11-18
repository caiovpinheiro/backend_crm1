/**
 * Roteamento MCP no middleware: URLs públicas do protocolo viram rotas
 * internas sem exigir sessão, e o processo `APP_MODE=mcp` não serve a API
 * do CRM (só /mcp, /oauth, /.well-known e health).
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTH_SECRET = "segredo-de-teste";
});
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn().mockResolvedValue(null) }));

import { middleware } from "@/middleware";

const saved = process.env.APP_MODE;
afterEach(() => {
  process.env.APP_MODE = saved;
});

function req(path: string, method = "GET") {
  return new NextRequest(`https://mcp.bwipo.com${path}`, { method, headers: { host: "mcp.bwipo.com" } });
}

function rewrittenTo(res: Response): string | null {
  const h = res.headers.get("x-middleware-rewrite");
  return h ? new URL(h).pathname : null;
}

describe("middleware — rotas MCP", () => {
  it.each([
    ["/mcp", "/api/mcp/server"],
    ["/.well-known/oauth-protected-resource", "/api/mcp/well-known/protected-resource"],
    ["/.well-known/oauth-protected-resource/mcp", "/api/mcp/well-known/protected-resource"],
    ["/.well-known/oauth-authorization-server", "/api/mcp/well-known/authorization-server"],
    ["/.well-known/openid-configuration", "/api/mcp/well-known/authorization-server"],
    ["/oauth/register", "/api/mcp/oauth/register"],
    ["/oauth/authorize?client_id=x", "/api/mcp/oauth/authorize"],
    ["/oauth/token", "/api/mcp/oauth/token"],
    ["/oauth/revoke", "/api/mcp/oauth/revoke"],
  ])("%s → %s sem sessão (sem redirect para /login)", async (path, target) => {
    const res = await middleware(req(path, path === "/mcp" ? "POST" : "GET"));
    expect(res.status).toBe(200);
    expect(rewrittenTo(res)).toBe(target);
  });

  it("APP_MODE=mcp responde 404 para a API do CRM", async () => {
    process.env.APP_MODE = "mcp";
    const res = await middleware(req("/api/deals"));
    expect(res.status).toBe(404);
    const health = await middleware(req("/api/health"));
    expect(health.status).not.toBe(404);
  });

  it("fora do modo MCP, /api/deals sem sessão continua 401", async () => {
    process.env.APP_MODE = "api";
    const res = await middleware(req("/api/deals"));
    expect(res.status).toBe(401);
  });
});
