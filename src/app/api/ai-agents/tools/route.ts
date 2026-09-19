import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { TOOLS_CATALOG } from "@/lib/ai-agents/tools-catalog";
import { prisma } from "@/lib/prisma";
import { getVerticalPack } from "@/verticals";

/**
 * GET /api/ai-agents/tools[?agentId=<id>]
 *
 * Quais ferramentas ESTE agente pode ter. A tela não decide: pergunta.
 *
 * O núcleo tem as ferramentas que servem a qualquer ramo (criar negócio,
 * transferir, encerrar). O pack do tenant pode acrescentar as do produto
 * dele. Enquanto a lista era estática no frontend, todo tenant — clínica,
 * loja, escritório — via na tela uma ferramenta de consulta acadêmica que
 * não existia para ele; ligar não fazia nada, porque o runtime nunca a
 * construía.
 *
 * Sem `agentId` devolve só o núcleo: é o caso do wizard, onde o agente
 * ainda não existe e portanto ainda não tem pack.
 */
export async function GET(request: Request) {
  return withOrgContext(async () => {
    const agentId = new URL(request.url).searchParams.get("agentId");

    let packId: string | null = null;
    if (agentId) {
      const agent = await prisma.aIAgentConfig.findUnique({
        where: { id: agentId },
        select: { verticalPack: true },
      });
      if (!agent) {
        return NextResponse.json(
          { message: "Agente não encontrado." },
          { status: 404 },
        );
      }
      packId = agent.verticalPack;
    }

    // `factory` é função: fica fora da resposta, que é metadado de tela.
    const packTools = (getVerticalPack(packId)?.extraTools ?? []).map(
      ({ factory: _factory, ...meta }) => ({ ...meta, pack: packId }),
    );

    return NextResponse.json({
      pack: packId,
      tools: [
        ...TOOLS_CATALOG.map((t) => ({ ...t, pack: null as string | null })),
        ...packTools,
      ],
    });
  });
}
