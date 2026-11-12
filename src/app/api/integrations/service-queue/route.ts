import { NextResponse } from "next/server";

import { cache } from "@/lib/cache";
import { withIntegrationsApi } from "@/lib/integrations-api";
import { getPainelAgora } from "@/services/painel-agora";
import { parseClockMode } from "@/services/painel-period";

export const dynamic = "force-dynamic";

/**
 * Cada cálculo são 5 consultas. Com o cache, a organização paga no máximo um
 * cálculo a cada 15 s por modo de relógio, seja qual for a frequência de
 * quem consulta. `asOf` diz de quando é o número.
 */
const SERVICE_QUEUE_TTL_SEC = 15;

/**
 * Fila de atendimento neste instante: os mesmos números do bloco "Agora" do
 * Painel de Atendimentos (`getPainelAgora`), sem os campos nominais da maior
 * espera (nome do contato e do atendente, id da conversa).
 *
 * Permissão: `report:view`. A rota de sessão equivalente
 * (`GET /api/painel/service`) só exige login; aqui o chamador é um token,
 * então vale a leitura de relatórios.
 */
export async function GET(request: Request) {
  return withIntegrationsApi(request, "report:view", async (user) => {
    const { searchParams } = new URL(request.url);
    const clock = parseClockMode(searchParams.get("clock"));
    const body = await cache.wrap(
      `integrations:service_queue:${user.organizationId}:${clock}`,
      SERVICE_QUEUE_TTL_SEC,
      async () => {
        const agora = await getPainelAgora(clock);
        // Só os números entram no cache: nada nominal.
        return {
          asOf: agora.asOf,
          awaitingReply: agora.awaitingReply,
          inService: agora.inService,
          longestWait: {
            ms: agora.longestWait.ms,
            overSla: agora.longestWait.overSla,
            slaMinutes: agora.longestWait.slaMinutes,
          },
          agents: agora.agents,
        };
      },
    );
    return NextResponse.json(body);
  });
}
