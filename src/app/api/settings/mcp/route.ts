/**
 * `/settings/mcp` — status, URL de conexão e configuração do MCP da org.
 * GET: qualquer usuário logado (vê o que pode fazer). PATCH: `mcp:manage`.
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { mcpResourceUrl } from "@/lib/mcp/config";
import { MCP_SCOPE_INFO, MCP_SCOPES } from "@/lib/mcp/scopes";
import { getMcpStatus } from "@/services/mcp/connections";
import { canUserConnectMcp, getMcpOrgConfig, updateMcpOrgConfig } from "@/services/mcp/settings";

import { viewerOf } from "./_shared";

const log = getLogger("api/settings/mcp");

export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const viewer = await viewerOf(session);
      if (!viewer) return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      const config = await getMcpOrgConfig(viewer.organizationId);
      const eligibility = await canUserConnectMcp(
        { id: viewer.id, organizationId: viewer.organizationId },
        config,
      );
      return NextResponse.json({
        config,
        canManage: viewer.canManage,
        canConnect: eligibility.ok,
        cannotConnectReason: eligibility.ok ? null : eligibility.reason,
        connectionUrl: mcpResourceUrl(),
        scopes: MCP_SCOPES.map((s) => ({ id: s, ...MCP_SCOPE_INFO[s] })),
        status: viewer.canManage ? await getMcpStatus(viewer.organizationId) : null,
      });
    } catch (err) {
      log.error({ err }, "GET falhou");
      return NextResponse.json({ message: "Erro ao carregar a integração MCP." }, { status: 500 });
    }
  });
}

export async function PATCH(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const viewer = await viewerOf(session);
      if (!viewer) return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      if (!viewer.canManage) {
        return NextResponse.json({ message: "Acesso negado.", required: "mcp:manage" }, { status: 403 });
      }
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }
      const config = await updateMcpOrgConfig(viewer.organizationId, viewer.id, {
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        allowAllUsers: typeof body.allowAllUsers === "boolean" ? body.allowAllUsers : undefined,
        exposeContactPii: typeof body.exposeContactPii === "boolean" ? body.exposeContactPii : undefined,
        allowedScopes: Array.isArray(body.allowedScopes) ? (body.allowedScopes as never) : undefined,
      });
      return NextResponse.json({ config });
    } catch (err) {
      log.error({ err }, "PATCH falhou");
      return NextResponse.json({ message: "Erro ao salvar a configuração." }, { status: 500 });
    }
  });
}
