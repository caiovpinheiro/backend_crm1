import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getDealsOverview } from "@/services/dashboard-v2";
import type { AnalyticsPeriod } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/deals-overview");

function parsePeriod(searchParams: URLSearchParams): AnalyticsPeriod {
  const fromS = searchParams.get("from");
  const toS = searchParams.get("to");
  const from = fromS ? new Date(fromS) : null;
  const to = toS ? new Date(toS) : null;
  if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
    return { from, to };
  }
  // Default: últimos 30 dias.
  const now = new Date();
  return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: now };
}

export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const period = parsePeriod(searchParams);
      const ownerId = searchParams.get("ownerId") || undefined;

      let pipelineId = searchParams.get("pipelineId") || "";
      if (!pipelineId) {
        const def =
          (await prisma.pipeline.findFirst({
            where: { isDefault: true, archivedAt: null },
            select: { id: true },
          })) ??
          (await prisma.pipeline.findFirst({
            where: { archivedAt: null },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          }));
        pipelineId = def?.id ?? "";
      }

      if (!pipelineId) {
        return NextResponse.json(
          { stages: [], newInPeriod: { count: 0, value: 0 }, summary: { totalValue: 0, totalDeals: 0, winRate: 0, avgTicket: 0, deltas: { winRate: 0, avgTicket: 0 } } },
        );
      }

      const data = await getDealsOverview(period, pipelineId, ownerId);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "[analytics/deals-overview] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar visão de negócios." },
        { status: 500 },
      );
    }
  });
}
