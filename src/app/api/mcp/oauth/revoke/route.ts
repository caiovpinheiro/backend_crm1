/** RFC 7009 — `POST /oauth/revoke`. Sempre 200 para token desconhecido. */
import { getLogger } from "@/lib/logger";
import {
  clientCredentials,
  mcpJson,
  preflight,
  rateLimitByIp,
  readFormOrJson,
  rejectIfNotMcpProcess,
} from "@/lib/mcp/http";
import { authenticateClient, findClient, OAuthError, revokeTokenByValue } from "@/services/mcp/oauth";

export const dynamic = "force-dynamic";

const log = getLogger("mcp.oauth.revoke");

export async function POST(request: Request) {
  const blocked = rejectIfNotMcpProcess();
  if (blocked) return blocked;
  const limited = await rateLimitByIp(request, "mcp.oauth");
  if (limited) return limited;
  const body = await readFormOrJson(request);
  try {
    const { clientId, clientSecret } = clientCredentials(request, body);
    const client = await findClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Cliente desconhecido.", 401);
    authenticateClient(client, clientSecret);
    if (body.token) await revokeTokenByValue(client, body.token);
    return mcpJson({});
  } catch (err) {
    if (err instanceof OAuthError) return mcpJson(err.toJSON(), err.status);
    log.error({ err: (err as Error).message }, "[mcp.oauth] revoke falhou");
    return mcpJson({ error: "server_error", error_description: "Erro interno." }, 500);
  }
}

export function OPTIONS() {
  return preflight();
}
