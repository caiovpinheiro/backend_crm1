import { NextResponse } from "next/server";

import { isAdmin, isSuperAdmin, requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { RefreshCooldownError, refreshOrgModelCatalog } from "@/services/ai-v2/model-catalog";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/models/refresh");

/**
 * "Atualizar modelos": consulta a lista de modelos da OpenAI e da Anthropic
 * com a chave gravada (do agente informado ou de outro agente da
 * organização) e grava o catálogo. Só admin da organização. A chave não
 * sai do servidor; a resposta traz só a lista e o resumo por provedor.
 */
export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  if (!isAdmin(r.session) && !isSuperAdmin(r.session)) {
    return NextResponse.json({ message: "Só o admin da organização pode atualizar a lista de modelos." }, { status: 403 });
  }
  return runInSessionContext(r.session, async () => {
    const organizationId = r.session.user.organizationId!;
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as { agentId?: unknown };
      let agentId: string | undefined;
      if (typeof body.agentId === "string" && body.agentId.trim()) {
        const agent = await getV2Agent(body.agentId.trim(), organizationId);
        if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });
        agentId = agent.id;
      }
      const out = await refreshOrgModelCatalog({ organizationId, userId: r.session.user.id, agentId });
      return NextResponse.json(out);
    } catch (err) {
      if (err instanceof RefreshCooldownError) {
        return NextResponse.json(
          { message: err.message, retryAfterSec: err.retryAfterSec },
          { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } },
        );
      }
      log.error({ err }, "[POST /api/ai-agents-v2/models/refresh]");
      return NextResponse.json({ message: "Não foi possível atualizar os modelos." }, { status: 500 });
    }
  });
}
