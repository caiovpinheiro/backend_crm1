import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { isMcpServerAllowedOnThisProcess } from "@/lib/mcp/config";
import { intersectScopes, parseScopeParam, sanitizeScopes } from "@/lib/mcp/scopes";
import { sanitizeArgs } from "@/lib/mcp/audit";
import { validateRedirectUri, verifyPkce } from "@/services/mcp/oauth";
import { parseMcpConfig } from "@/services/mcp/settings";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("MCP — unidades", () => {
  it("PKCE S256", () => {
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce("curto", challenge)).toBe(false);
  });

  it("redirect_uri", () => {
    expect(validateRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validateRedirectUri("https://x.com/cb#frag")).toBe(false);
    expect(validateRedirectUri("https://user:pw@x.com/cb")).toBe(false);
    expect(validateRedirectUri("data:text/html,x")).toBe(false);
    expect(validateRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
  });

  it("escopos: parse, saneamento e interseção nunca ampliam", () => {
    expect(parseScopeParam("leads:read admin:write messages:read")).toEqual(["leads:read", "messages:read"]);
    expect(sanitizeScopes(["x", "team:read", 1])).toEqual(["team:read"]);
    expect(intersectScopes(["leads:read", "team:read"], ["team:read"])).toEqual(["team:read"]);
  });

  it("config padrão: MCP desligado, PII mascarada, só quem tem permissão conecta", () => {
    const c = parseMcpConfig(null);
    expect(c).toMatchObject({ enabled: false, allowAllUsers: false, exposeContactPii: false });
    expect(parseMcpConfig("{lixo").enabled).toBe(false);
  });

  it("auditoria não guarda texto livre", () => {
    expect(sanitizeArgs({ search: "Maria 11999998888", status: "OPEN", page: 2 })).toEqual({
      search: "[texto: 17 caracteres]",
      status: "OPEN",
      page: 2,
    });
  });

  it("rotas do servidor MCP só no processo mcp em produção", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.APP_MODE = "api";
    delete process.env.MCP_ALLOW_ON_MAIN_API;
    expect(isMcpServerAllowedOnThisProcess()).toBe(false);
    process.env.APP_MODE = "api-public";
    expect(isMcpServerAllowedOnThisProcess()).toBe(false);
    process.env.APP_MODE = "mcp";
    expect(isMcpServerAllowedOnThisProcess()).toBe(true);
  });
});
