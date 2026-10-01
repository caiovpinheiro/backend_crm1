/**
 * GET /api/channels/instagram/oauth/callback?code=&state=
 *
 * Landing publico do OAuth Instagram. Meta redireciona pra ca depois
 * que o usuario autoriza no instagram.com. Validamos o state, rodamos
 * a troca de token / subscribe / persist dentro de withSystemContext
 * (org resolvida do state) e devolvemos uma pagina HTML minima que
 * fecha o popup e notifica o parent via window.postMessage.
 */
import { resolveAppOriginForOrg } from "@/lib/app-origin";
import { withSystemContext } from "@/lib/webhook-context";
import {
  IgOAuthError,
  handleCallback,
  verifyState,
} from "@/services/channels-instagram-oauth";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/instagram/oauth/callback");

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * SEC-22: `postMessage` só para a origem do app (tenant/APP_URL), nunca
 * `"*"`. Sem origem resolvível, não notifica o opener — o operador fecha
 * a janela e recarrega a lista de canais.
 */
function renderResult(
  ok: boolean,
  payload: Record<string, unknown>,
  message: string,
  targetOrigin: string | null,
): Response {
  const json = JSON.stringify({ type: "IG_OAUTH_DONE", ok, ...payload });
  const notify = targetOrigin
    ? `try {
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify(json)}, ${JSON.stringify(targetOrigin)});
  }
} catch (e) {}
`
    : "";
  return html(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Instagram</title>
<style>body{font-family:system-ui,sans-serif;padding:24px;color:#111}</style></head>
<body>
<p>${ok ? "Conta Instagram conectada com sucesso." : `Erro: ${escapeHtml(message)}`}</p>
<p><small>Voce pode fechar esta janela.</small></p>
<script>
${notify}setTimeout(function(){ try { window.close(); } catch(e) {} }, 400);
</script>
</body></html>`,
    ok ? 200 : 400,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code")?.trim() || "";
  const state = searchParams.get("state")?.trim() || "";
  const errorParam = searchParams.get("error_description") || searchParams.get("error");

  // Antes de validar o state não há org → só APP_URL explícita (se houver).
  const fallbackOrigin = await resolveAppOriginForOrg(null);

  if (errorParam) {
    return renderResult(false, { message: errorParam }, errorParam, fallbackOrigin);
  }
  if (!code || !state) {
    return renderResult(
      false,
      { message: "code/state ausentes na resposta da Meta." },
      "code/state ausentes na resposta da Meta.",
      fallbackOrigin,
    );
  }

  const s = verifyState(state);
  if (!s) {
    return renderResult(
      false,
      { message: "state invalido (CSRF ou expirado)." },
      "state invalido (CSRF ou expirado).",
      fallbackOrigin,
    );
  }

  const targetOrigin = await resolveAppOriginForOrg(s.orgId);

  try {
    const result = await withSystemContext(s.orgId, () => handleCallback(code));
    return renderResult(true, {
      channelId: result.channel.id,
      username: result.username,
    }, "", targetOrigin);
  } catch (e: unknown) {
    const msg =
      e instanceof IgOAuthError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Erro no callback OAuth.";
    log.error({ err: e }, "[ig-oauth/callback] falhou");
    return renderResult(false, { message: msg }, msg, targetOrigin);
  }
}
