/**
 * Endpoint MCP (Streamable HTTP) — público em `/mcp` (reescrita no
 * middleware). Só aceita access token MCP (`bwmcp_at_…`); tokens de API
 * `eduit_…` e cookie de sessão NÃO valem aqui.
 */
import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import {
  mcpJson,
  preflight,
  protectedResourceMetadataUrl,
  rejectIfNotMcpProcess,
  withMcpHeaders,
} from "@/lib/mcp/http";
import { handleMcpHttp } from "@/lib/mcp/server";
import { validateAccessToken } from "@/services/mcp/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = getLogger("mcp.http");

function unauthorized(request: Request, error?: string): NextResponse {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(request)}"`];
  if (error) parts.push(`error="invalid_token"`, `error_description="${error}"`);
  return mcpJson(
    { error: error ? "invalid_token" : "unauthorized", error_description: "Autorização necessária." },
    401,
    { "WWW-Authenticate": `Bearer ${parts.join(", ")}` },
  );
}

async function handle(request: Request): Promise<Response> {
  const blocked = rejectIfNotMcpProcess();
  if (blocked) return blocked;
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return unauthorized(request);
  const v = await validateAccessToken(m[1]);
  if (!v.ok) return unauthorized(request, v.reason);
  try {
    const res = await handleMcpHttp(request, v.principal);
    return withMcpHeaders(res);
  } catch (err) {
    log.error({ err: (err as Error).message }, "[mcp] requisição falhou");
    return mcpJson(
      { jsonrpc: "2.0", error: { code: -32603, message: "Erro interno." }, id: null },
      500,
    );
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

export function OPTIONS() {
  return preflight();
}
