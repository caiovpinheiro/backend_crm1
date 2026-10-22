/**
 * Troca o `code` do Embedded Signup por access token.
 * O mesmo caminho do POST /api/channels/embedded-signup: sem redirect_uri.
 * O App Secret não sai deste módulo.
 */
import { CRM_META_APP_ID, CRM_META_APP_SECRET } from "@/lib/meta-constants";
import { getLogger } from "@/lib/logger";
import { MetaProvisionError } from "@/services/channels-meta-provision";

const log = getLogger("meta-embedded-signup-token");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export async function exchangeEmbeddedSignupCode(input: {
  code: string;
  appSecret?: string;
}): Promise<string> {
  const appSecret = input.appSecret?.trim() || CRM_META_APP_SECRET;
  const tokenUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", CRM_META_APP_ID);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("code", input.code);

  const tokenRes = await fetch(tokenUrl.toString());
  const tokenData = (await tokenRes.json()) as Record<string, unknown>;

  if (!tokenRes.ok || tokenData.error) {
    const errMsg =
      typeof tokenData.error === "object" && tokenData.error !== null
        ? ((tokenData.error as Record<string, unknown>).message as string)
        : "Falha ao trocar código por token.";
    const metaErr =
      typeof tokenData.error === "object" && tokenData.error !== null
        ? (tokenData.error as Record<string, unknown>)
        : {};
    log.error(
      {
        status: tokenRes.status,
        code: metaErr.code ?? null,
        type: metaErr.type ?? null,
        subcode: metaErr.error_subcode ?? null,
      },
      "Embedded Signup token exchange error",
    );
    throw new MetaProvisionError(errMsg || "Falha ao trocar código por token.", 400);
  }

  const accessToken =
    typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  if (!accessToken) {
    throw new MetaProvisionError("Token de acesso não retornado pela Meta.", 502);
  }
  return accessToken;
}
