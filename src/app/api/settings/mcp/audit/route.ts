/** Histórico de consultas MCP (sem conteúdo). Próprio; `?all=1` com `mcp:manage`. */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { listAuditLogs } from "@/services/mcp/connections";

import { viewerOf } from "../_shared";

const log = getLogger("api/settings/mcp/audit");

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const viewer = await viewerOf(session);
      if (!viewer) return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      const sp = new URL(request.url).searchParams;
      const cursor = sp.get("cursor");
      if (cursor && Number.isNaN(new Date(cursor).getTime())) {
        return NextResponse.json({ message: "cursor inválido." }, { status: 400 });
      }
      const limit = Number(sp.get("limit") ?? "50");
      return NextResponse.json(
        await listAuditLogs(viewer, {
          all: sp.get("all") === "1",
          connectionId: sp.get("connectionId") ?? undefined,
          cursor: cursor ?? undefined,
          limit: Number.isFinite(limit) ? limit : 50,
        }),
      );
    } catch (err) {
      log.error({ err }, "GET falhou");
      return NextResponse.json({ message: "Erro ao carregar o histórico." }, { status: 500 });
    }
  });
}
