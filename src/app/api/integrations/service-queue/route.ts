import { NextResponse } from "next/server";

import { withIntegrationsApi } from "@/lib/integrations-api";
import { getPainelAgora } from "@/services/painel-agora";
import { parseClockMode } from "@/services/painel-period";

export const dynamic = "force-dynamic";

/**
 * Fila de atendimento neste instante: os mesmos números do bloco "Agora" do
 * Painel de Atendimentos (`getPainelAgora`), sem os campos nominais da maior
 * espera (nome do contato e do atendente, id da conversa).
 *
 * Permissão: `report:view`. A rota de sessão equivalente
 * (`GET /api/painel/service`) só exige login; aqui o chamador pode ser um
 * token, então vale a leitura de relatórios.
 */
export async function GET(request: Request) {
  return withIntegrationsApi(request, "report:view", async () => {
    const { searchParams } = new URL(request.url);
    const agora = await getPainelAgora(parseClockMode(searchParams.get("clock")));
    return NextResponse.json({
      asOf: agora.asOf,
      awaitingReply: agora.awaitingReply,
      inService: agora.inService,
      longestWait: {
        ms: agora.longestWait.ms,
        overSla: agora.longestWait.overSla,
        slaMinutes: agora.longestWait.slaMinutes,
      },
      agents: agora.agents,
    });
  });
}
