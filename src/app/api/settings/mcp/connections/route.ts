/** Conexões MCP: as próprias; `?all=1` (com `mcp:manage`) todas da org. */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import { listConnections } from "@/services/mcp/connections";

import { viewerOf } from "../_shared";

const log = getLogger("api/settings/mcp/connections");

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const viewer = await viewerOf(session);
      if (!viewer) return NextResponse.json({ message: "Sessão sem organização." }, { status: 401 });
      const sp = new URL(request.url).searchParams;
      const items = await listConnections(viewer, {
        all: sp.get("all") === "1",
        includeRevoked: sp.get("includeRevoked") === "1",
      });
      return NextResponse.json({ items });
    } catch (err) {
      log.error({ err }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar conexões." }, { status: 500 });
    }
  });
}
