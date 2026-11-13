import { NextResponse } from "next/server";

import { isAdmin, isSuperAdmin, requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getAgentTokenUsage, getOrgModelCatalog } from "@/services/ai-v2/model-catalog";
import { getV2Agent } from "@/services/ai-v2/agents";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/models");

/**
 * Catálogo de modelos da organização (fixos + descobertos) e a última
 * atualização. Com `?agentId=`, traz também a média de tokens por conversa
 * do agente (últimos 30 dias) para a tela estimar o custo por conversa.
 */
export async function GET(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {
    try {
      const organizationId = r.session.user.organizationId!;
      const agentId = new URL(request.url).searchParams.get("agentId")?.trim();
      const agent = agentId ? await getV2Agent(agentId, organizationId).catch(() => null) : null;
      const [catalog, usage] = await Promise.all([
        getOrgModelCatalog(organizationId),
        agent ? getAgentTokenUsage(organizationId, agent.id) : Promise.resolve(null),
      ]);
      return NextResponse.json({ ...catalog, usage, canManage: isAdmin(r.session) || isSuperAdmin(r.session) });
    } catch (err) {
      log.error({ err }, "[GET /api/ai-agents-v2/models]");
      return NextResponse.json({ message: "Erro ao carregar os modelos." }, { status: 500 });
    }
  });
}
