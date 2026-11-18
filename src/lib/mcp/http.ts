/**
 * Helpers HTTP das rotas do servidor MCP/OAuth (`/mcp`, `/oauth/*`,
 * `/.well-known/oauth-*`). As URLs públicas são reescritas pelo middleware
 * para `/api/mcp/*`.
 *
 * CORS `*` é seguro aqui: nenhuma dessas rotas usa cookie — a credencial é
 * sempre o Bearer/PKCE do próprio cliente. (Clientes web, como o MCP
 * Inspector, precisam do preflight.)
 */
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/client-ip";
import { isMcpServerAllowedOnThisProcess, mcpPublicOrigin } from "@/lib/mcp/config";
import { MCP_SCOPES } from "@/lib/mcp/scopes";
import { consumeRateLimit, type RateLimitProfile } from "@/lib/rate-limit";

export const MCP_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "600",
};

export function withMcpHeaders<T extends Response>(res: T): T {
  for (const [k, v] of Object.entries(MCP_CORS_HEADERS)) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export function mcpJson(body: unknown, status = 200, headers?: Record<string, string>): NextResponse {
  return withMcpHeaders(NextResponse.json(body, { status, headers }));
}

export function preflight(): NextResponse {
  return withMcpHeaders(new NextResponse(null, { status: 204 }));
}

/** 404 fora do processo MCP (produção). `null` = pode seguir. */
export function rejectIfNotMcpProcess(): NextResponse | null {
  if (isMcpServerAllowedOnThisProcess()) return null;
  return NextResponse.json({ message: "Not found" }, { status: 404 });
}

export function ipHash(request: Request): string {
  return createHash("sha256").update(getClientIp(request)).digest("hex").slice(0, 32);
}

export async function rateLimitByIp(
  request: Request,
  profile: RateLimitProfile,
): Promise<NextResponse | null> {
  const rl = await consumeRateLimit(`mcp-ip:${ipHash(request)}`, profile);
  if (rl.allowed) return null;
  return mcpJson(
    { error: "rate_limited", error_description: "Muitas requisições. Tente novamente em instantes." },
    429,
    { "Retry-After": String(rl.retryAfterSec) },
  );
}

export function protectedResourceMetadataUrl(request?: Request): string {
  return `${mcpPublicOrigin(request)}/.well-known/oauth-protected-resource/mcp`;
}

export function protectedResourceMetadata(request?: Request) {
  const origin = mcpPublicOrigin(request);
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "CRM Bwipo",
    resource_documentation: `${origin}/mcp`,
  };
}

export function authorizationServerMetadata(request?: Request) {
  const origin = mcpPublicOrigin(request);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/mcp`,
  };
}

/** Lê corpo `application/x-www-form-urlencoded` (padrão OAuth) ou JSON. */
export async function readFormOrJson(request: Request): Promise<Record<string, string>> {
  const ct = request.headers.get("content-type") ?? "";
  const text = (await request.text()).slice(0, 20_000);
  if (ct.includes("application/json")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(j)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** Credenciais do cliente: Basic ou corpo (`client_id`/`client_secret`). */
export function clientCredentials(
  request: Request,
  body: Record<string, string>,
): { clientId: string | null; clientSecret: string | null } {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, idx)),
          clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
        };
      }
    } catch {
      /* cai no corpo */
    }
  }
  return { clientId: body.client_id ?? null, clientSecret: body.client_secret ?? null };
}
