/**
 * RFC 8414 — `/.well-known/oauth-authorization-server` e
 * `/.well-known/openid-configuration` (alguns clientes só tentam esta).
 */
import {
  authorizationServerMetadata,
  mcpJson,
  preflight,
  rejectIfNotMcpProcess,
} from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const blocked = rejectIfNotMcpProcess();
  if (blocked) return blocked;
  return mcpJson(authorizationServerMetadata(request));
}

export function OPTIONS() {
  return preflight();
}
