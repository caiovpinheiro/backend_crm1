/** `POST /oauth/token` — authorization_code (+PKCE) e refresh_token. */
import { getLogger } from "@/lib/logger";
import {
  clientCredentials,
  mcpJson,
  preflight,
  rateLimitByIp,
  readFormOrJson,
  rejectIfNotMcpProcess,
} from "@/lib/mcp/http";
import {
  authenticateClient,
  exchangeAuthorizationCode,
  findClient,
  OAuthError,
  refreshAccessToken,
} from "@/services/mcp/oauth";

export const dynamic = "force-dynamic";

const log = getLogger("mcp.oauth.token");

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

    if (body.grant_type === "authorization_code") {
      if (!body.code || !body.code_verifier) {
        throw new OAuthError("invalid_request", "code e code_verifier são obrigatórios.");
      }
      return mcpJson(
        await exchangeAuthorizationCode({
          client,
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri ?? null,
          resource: body.resource ?? null,
        }),
      );
    }
    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) throw new OAuthError("invalid_request", "refresh_token obrigatório.");
      return mcpJson(
        await refreshAccessToken({
          client,
          refreshToken: body.refresh_token,
          scope: body.scope ?? null,
        }),
      );
    }
    throw new OAuthError("unsupported_grant_type", "grant_type não suportado.");
  } catch (err) {
    if (err instanceof OAuthError) {
      return mcpJson(
        err.toJSON(),
        err.status,
        err.status === 401 ? { "WWW-Authenticate": 'Basic realm="mcp"' } : undefined,
      );
    }
    log.error({ err: (err as Error).message }, "[mcp.oauth] token falhou");
    return mcpJson({ error: "server_error", error_description: "Erro interno." }, 500);
  }
}

export function OPTIONS() {
  return preflight();
}
