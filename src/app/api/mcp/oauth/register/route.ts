/** RFC 7591 — registro dinâmico de cliente (`POST /oauth/register`). */
import { getLogger } from "@/lib/logger";
import {
  ipHash,
  mcpJson,
  preflight,
  rateLimitByIp,
  rejectIfNotMcpProcess,
} from "@/lib/mcp/http";
import { OAuthError, registerClient } from "@/services/mcp/oauth";

export const dynamic = "force-dynamic";

const log = getLogger("mcp.oauth.register");

export async function POST(request: Request) {
  const blocked = rejectIfNotMcpProcess();
  if (blocked) return blocked;
  const limited = await rateLimitByIp(request, "mcp.register");
  if (limited) return limited;
  let body: unknown;
  try {
    body = JSON.parse((await request.text()).slice(0, 20_000));
  } catch {
    return mcpJson({ error: "invalid_client_metadata", error_description: "JSON inválido." }, 400);
  }
  if (!body || typeof body !== "object") {
    return mcpJson({ error: "invalid_client_metadata", error_description: "Corpo inválido." }, 400);
  }
  try {
    const res = await registerClient(body as Record<string, unknown>, ipHash(request));
    return mcpJson(res, 201);
  } catch (err) {
    if (err instanceof OAuthError) return mcpJson(err.toJSON(), err.status);
    log.error({ err: (err as Error).message }, "[mcp.oauth] register falhou");
    return mcpJson({ error: "server_error", error_description: "Erro interno." }, 500);
  }
}

export function OPTIONS() {
  return preflight();
}
