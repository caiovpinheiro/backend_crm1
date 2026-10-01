import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getAgentAutomations } from "@/services/automations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/agent-runnable");

/**
 * GET /api/automations/agent-runnable
 *
 * Lista as automações que o AGENTE pode disparar manualmente pela conversa
 * (picker do composer): ativas e com `triggerType='manual'` OU
 * `allowManualRun=true`. Enriquecidas com categoria + preview da mensagem.
 *
 * Acessível a qualquer usuário autenticado (igual aos templates) — NÃO exige
 * `automation:view` (que é permissão de gestor). O disparo em si continua
 * validado em POST /api/automations/[id]/run.
 */
export async function GET() {
  return withOrgContext(async () => {
    try {
      const items = await getAgentAutomations();
      return NextResponse.json({ items, total: items.length });
    } catch (e) {
      log.error({ err: e }, "[GET /api/automations/agent-runnable] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar automações." },
        { status: 500 },
      );
    }
  });
}
