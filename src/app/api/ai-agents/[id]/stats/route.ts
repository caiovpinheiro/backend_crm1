import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

/**
 * Estatísticas de uso de um agente: totais, série diária e últimos runs.
 * Serve o painel "Uso" no dialog de edição e a aba "Agentes IA" no
 * /monitor.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const orgIdFilter = session.user.organizationId;
    if (!orgIdFilter) {
      return NextResponse.json(
        { message: "Sem organizacao no contexto." },
        { status: 403 },
      );
    }
    const { id } = await params;
    const url = new URL(request.url);
    const days = Math.min(
      Math.max(Number(url.searchParams.get("days")) || 7, 1),
      30,
    );

    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // Run de teste (comando `/teste` no WhatsApp) usa o agente de verdade e
    // gasta token de verdade, mas não é atendimento: contar custo, confiança
    // média e desfecho junto com produção falsearia o painel. Fica fora dos
    // agregados e continua aparecendo na lista dos últimos runs, onde a
    // coluna `source` diz o que ele é.
    const productionOnly = { source: { not: "inbox_test" } } as const;

    const [
      totals,
      statusBreak,
      handoffBreak,
      perDay,
      lastRuns,
      draftsPending,
    ] = await Promise.all([
        prisma.aIAgentRun.aggregate({
          where: { agentId: id, createdAt: { gte: since }, ...productionOnly },
          _sum: { inputTokens: true, outputTokens: true, costUsd: true },
          _avg: { confidence: true },
          _count: { _all: true },
        }),
        prisma.aIAgentRun.groupBy({
          by: ["status"],
          where: { agentId: id, createdAt: { gte: since }, ...productionOnly },
          _count: { _all: true },
        }),
        prisma.aIAgentRun.groupBy({
          by: ["handoffReason"],
          where: {
            agentId: id,
            createdAt: { gte: since },
            handoffReason: { not: null },
            ...productionOnly,
          },
          _count: { _all: true },
        }),
        // Defesa em profundidade: agentId vem do path; embora o caller
        // tipicamente carregue o agente com prisma scoped antes, esse raw
        // nao passa pela extension. Filtramos organizationId pra alinhar.
        prisma.$queryRaw<
          Array<{ day: Date; runs: bigint; tokens: bigint; cost: number }>
        >`
          SELECT DATE_TRUNC('day', "createdAt") AS day,
                 COUNT(*) AS runs,
                 SUM("inputTokens" + "outputTokens") AS tokens,
                 SUM("costUsd") AS cost
            FROM "ai_agent_runs"
           WHERE "agentId" = ${id}
             AND "createdAt" >= ${since}
             AND "organizationId" = ${orgIdFilter}
             AND "source" <> 'inbox_test'
           GROUP BY DATE_TRUNC('day', "createdAt")
           ORDER BY day ASC
        `,
        prisma.aIAgentRun.findMany({
          where: { agentId: id },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            source: true,
            status: true,
            confidence: true,
            handoffReason: true,
            inputTokens: true,
            outputTokens: true,
            costUsd: true,
            responsePreview: true,
            errorMessage: true,
            createdAt: true,
            finishedAt: true,
          },
        }),
        prisma.message.count({
          where: {
            aiAgentUser: { aiAgentConfig: { id } },
            messageType: "ai_draft",
            isPrivate: true,
          },
        }),
      ]);

    const statusCounts = statusBreak.reduce(
      (acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      },
      {} as Record<string, number>,
    );

    const handoffReasons = handoffBreak.reduce(
      (acc, row) => {
        if (row.handoffReason) acc[row.handoffReason] = row._count._all;
        return acc;
      },
      {} as Record<string, number>,
    );

    return NextResponse.json({
      windowDays: days,
      totals: {
        runs: totals._count._all ?? 0,
        inputTokens: totals._sum.inputTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
        costUsd: Number((totals._sum.costUsd ?? 0).toFixed(4)),
        avgConfidence:
          totals._avg.confidence != null
            ? Number(totals._avg.confidence.toFixed(2))
            : null,
      },
      statusCounts,
      handoffReasons,
      perDay: perDay.map((d) => ({
        day: d.day,
        runs: Number(d.runs ?? 0),
        tokens: Number(d.tokens ?? 0),
        cost: Number(d.cost ?? 0),
      })),
      lastRuns,
      draftsPending,
    });
  });
}
