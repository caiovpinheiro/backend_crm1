import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getServiceOverview } from "@/services/dashboard-v2";
import type { AnalyticsPeriod } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/service-overview");

function parsePeriod(searchParams: URLSearchParams): AnalyticsPeriod {
  const fromS = searchParams.get("from");
  const toS = searchParams.get("to");
  const from = fromS ? new Date(fromS) : null;
  const to = toS ? new Date(toS) : null;
  if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
    return { from, to };
  }
  const now = new Date();
  return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: now };
}

export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const period = parsePeriod(searchParams);
      const data = await getServiceOverview(period);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "[analytics/service-overview] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar visão de atendimento." },
        { status: 500 },
      );
    }
  });
}
