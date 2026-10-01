import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getTeamPerformance, type AnalyticsPeriod } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/team");

function parseOptionalPeriod(
  searchParams: URLSearchParams
): AnalyticsPeriod | undefined {
  const fromS = searchParams.get("from");
  const toS = searchParams.get("to");
  if (!fromS || !toS) return undefined;
  const from = new Date(fromS);
  const to = new Date(toS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return undefined;
  }
  return { from, to };
}

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const period = parseOptionalPeriod(searchParams);
    if (
      (searchParams.get("from") || searchParams.get("to")) &&
      !period
    ) {
      return NextResponse.json(
        { message: "Parâmetros from e to devem ser datas ISO válidas." },
        { status: 400 }
      );
    }

    const data = await getTeamPerformance(period);
    return NextResponse.json(data);
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: "Erro ao carregar desempenho da equipe." },
      { status: 500 }
    );
  }
}
