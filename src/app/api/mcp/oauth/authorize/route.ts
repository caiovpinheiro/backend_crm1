/**
 * `GET /oauth/authorize` — valida o pedido (cliente, redirect, PKCE,
 * resource) e manda o usuário para a tela de consentimento do CRM
 * (frontend, com login). O código só é emitido depois do "Permitir"
 * (`POST /api/settings/mcp/consent` na API principal).
 */
import { NextResponse } from "next/server";

import { mcpConsentUrl } from "@/lib/mcp/config";
import { rateLimitByIp, rejectIfNotMcpProcess, withMcpHeaders } from "@/lib/mcp/http";
import {
  authorizeParamsFrom,
  buildRedirect,
  validateAuthorizeRequest,
} from "@/services/mcp/oauth";

export const dynamic = "force-dynamic";

function errorPage(message: string, status = 400): NextResponse {
  // Texto puro: nada do pedido é refletido em HTML.
  return withMcpHeaders(
    new NextResponse(`Não foi possível conectar ao CRM Bwipo.\n\n${message}\n`, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
}

export async function GET(request: Request) {
  const blocked = rejectIfNotMcpProcess();
  if (blocked) return blocked;
  const limited = await rateLimitByIp(request, "mcp.oauth");
  if (limited) return limited;
  const url = new URL(request.url);
  const params = authorizeParamsFrom(url.searchParams);
  const v = await validateAuthorizeRequest(params, request);
  if (!v.ok) {
    if (!v.redirectable) return errorPage(v.error.description);
    return NextResponse.redirect(
      buildRedirect(v.redirectUri, {
        error: v.error.error,
        error_description: v.error.description,
        state: v.state,
      }),
      302,
    );
  }
  const consent = new URL(mcpConsentUrl());
  for (const [k, val] of Object.entries(params)) {
    if (typeof val === "string" && val) consent.searchParams.set(k, val);
  }
  if (!params.redirect_uri) consent.searchParams.set("redirect_uri", v.value.redirectUri);
  return NextResponse.redirect(consent.toString(), 302);
}
