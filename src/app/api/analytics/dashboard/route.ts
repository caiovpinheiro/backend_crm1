import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getDashboardMetrics, type AnalyticsPeriod } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/dashboard");

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

// Bug 24/abr/26: usavamos `auth()` direto e o handler chamava
// `getDashboardMetrics` que depende de `getOrgIdOrThrow()` — sem o
// AsyncLocalStorage scope ativo, getOrgIdOrThrow() explodia. Trocamos
// por `withOrgContext` que envolve a lambda em runWithContext,
// garantindo que tudo dentro veja o tenant scope.
export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
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

      const data = await getDashboardMetrics(period);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json(
        { message: "Erro ao carregar métricas do painel." },
        { status: 500 }
      );
    }
  });
}
