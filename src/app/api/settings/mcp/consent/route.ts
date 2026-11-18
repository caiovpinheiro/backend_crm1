/**
 * Consentimento OAuth do MCP — chamado pela tela `/oauth/consent` do
 * frontend, com a sessão do usuário (cookie). O pedido OAuth é revalidado
 * aqui por inteiro (cliente, redirect registrado, PKCE): o frontend só
 * repassa os parâmetros.
 *
 * GET  ?<parâmetros do /oauth/authorize> → descrição do cliente e escopos.
 * POST { params, approve, scopes }      → { redirectTo } (code ou error).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { MCP_SCOPE_INFO } from "@/lib/mcp/scopes";
import { prismaBase } from "@/lib/prisma-base";
import {
  approveAuthorization,
  authorizeParamsFrom,
  buildRedirect,
  OAuthError,
  validateAuthorizeRequest,
  type AuthorizeParams,
} from "@/services/mcp/oauth";
import { canUserConnectMcp } from "@/services/mcp/settings";

const log = getLogger("api/settings/mcp/consent");

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}//`;
  } catch {
    return uri;
  }
}

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const params = authorizeParamsFrom(new URL(request.url).searchParams);
      const v = await validateAuthorizeRequest(params);
      if (!v.ok) {
        return NextResponse.json(
          { message: v.error.description, error: v.error.error },
          { status: 400 },
        );
      }
      const user = { id: session.user.id, organizationId: session.user.organizationId };
      const elig = await canUserConnectMcp(user);
      const allowed = new Set(elig.config.allowedScopes);
      const org = session.user.organizationId
        ? await prismaBase.organization.findUnique({
            where: { id: session.user.organizationId },
            select: { name: true },
          })
        : null;
      return NextResponse.json({
        client: {
          name: v.value.client.clientName,
          uri: v.value.client.clientUri,
          logoUri: v.value.client.logoUri,
          redirectHost: hostOf(v.value.redirectUri),
        },
        user: { name: session.user.name ?? null, email: session.user.email ?? null },
        organization: org?.name ?? null,
        canConnect: elig.ok,
        cannotConnectReason: elig.ok ? null : elig.reason,
        scopes: v.value.requestedScopes.map((s) => ({
          id: s,
          ...MCP_SCOPE_INFO[s],
          allowedByOrg: allowed.has(s),
        })),
      });
    } catch (err) {
      log.error({ err }, "GET falhou");
      return NextResponse.json({ message: "Erro ao validar o pedido." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    let body: { params?: AuthorizeParams; approve?: boolean; scopes?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
    try {
      const raw = body.params ?? {};
      const params: AuthorizeParams = {};
      for (const k of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "state", "resource"] as const) {
        const val = (raw as Record<string, unknown>)[k];
        if (typeof val === "string") params[k] = val;
      }
      const v = await validateAuthorizeRequest(params);
      if (!v.ok) {
        if (v.redirectable) {
          return NextResponse.json({
            redirectTo: buildRedirect(v.redirectUri, {
              error: v.error.error,
              error_description: v.error.description,
              state: v.state,
            }),
          });
        }
        return NextResponse.json({ message: v.error.description }, { status: 400 });
      }
      if (body.approve !== true) {
        return NextResponse.json({
          redirectTo: buildRedirect(v.value.redirectUri, {
            error: "access_denied",
            error_description: "O usuário recusou o acesso.",
            state: v.value.state,
          }),
        });
      }
      const chosen = Array.isArray(body.scopes)
        ? body.scopes.filter((s): s is string => typeof s === "string")
        : v.value.requestedScopes;
      const r = await approveAuthorization(
        { id: session.user.id, organizationId: session.user.organizationId },
        v.value,
        chosen,
      );
      return NextResponse.json({ redirectTo: r.redirectTo });
    } catch (err) {
      if (err instanceof OAuthError) {
        return NextResponse.json({ message: err.description, error: err.error }, { status: err.status });
      }
      log.error({ err }, "POST falhou");
      return NextResponse.json({ message: "Erro ao autorizar." }, { status: 500 });
    }
  });
}
