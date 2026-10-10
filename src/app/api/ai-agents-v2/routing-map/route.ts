import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getV2RoutingMap } from "@/services/ai-v2/config-validators";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/routing-map");

/** Mapa de roteamento da organização: nós = agentes/departamentos/pessoas, arestas = assunto → destino. */
export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      await ensureV2AgentSchema();
      const map = await getV2RoutingMap(r.session.user.organizationId!);
      return NextResponse.json(map);
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/routing-map]");
      return NextResponse.json({ message: err instanceof Error ? err.message : "Erro ao montar o mapa de roteamento." }, { status: 500 });
    }
  });
}
