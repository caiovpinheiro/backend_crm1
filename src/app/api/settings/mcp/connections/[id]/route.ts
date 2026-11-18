/** PATCH: reduzir escopos da conexão. DELETE: revogar (efeito imediato). */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { revokeConnectionAsViewer, updateConnectionScopes } from "@/services/mcp/connections";

import { viewerOf } from "../../_shared";

const log = getLogger("api/settings/mcp/connections/[id]");

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const viewer = await viewerOf(session);
      if (!viewer) return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      const { id } = await ctx.params;
      let body: { scopes?: unknown };
      try {
        body = (await request.json()) as { scopes?: unknown };
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }
      const r = await updateConnectionScopes(viewer, id, body.scopes);
      if (!r.ok) return NextResponse.json({ message: r.message }, { status: r.status });
      return NextResponse.json({ scopes: r.scopes });
    } catch (err) {
      log.error({ err }, "PATCH falhou");
      return NextResponse.json({ message: "Erro ao atualizar a conexão." }, { status: 500 });
    }
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const viewer = await viewerOf(session);
      if (!viewer) return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      const { id } = await ctx.params;
      const r = await revokeConnectionAsViewer(viewer, id);
      if (!r.ok) return NextResponse.json({ message: "Conexão não encontrada." }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      log.error({ err }, "DELETE falhou");
      return NextResponse.json({ message: "Erro ao revogar a conexão." }, { status: 500 });
    }
  });
}
