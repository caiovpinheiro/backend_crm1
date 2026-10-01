import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getDashboardMetrics, type AnalyticsPeriod } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/dashboard/compare");

// Bug 24/abr/26: usavamos `auth()` direto e o handler chamava
// `getDashboardMetrics` que depende de `getOrgIdOrThrow()` — sem o
// AsyncLocalStorage scope ativo, getOrgIdOrThrow() explodia. Trocamos
// por `withOrgContext` que envolve a lambda em runWithContext,
// garantindo que tudo dentro veja o tenant scope.
export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const fromS = searchParams.get("from");
      const toS = searchParams.get("to");
      const compFromS = searchParams.get("compFrom");
      const compToS = searchParams.get("compTo");

      if (!fromS || !toS || !compFromS || !compToS) {
        return NextResponse.json(
          { message: "Parâmetros from, to, compFrom e compTo são obrigatórios." },
          { status: 400 },
        );
      }

      const from = new Date(fromS);
      const to = new Date(toS);
      const compFrom = new Date(compFromS);
      const compTo = new Date(compToS);

      if ([from, to, compFrom, compTo].some((d) => Number.isNaN(d.getTime()))) {
        return NextResponse.json(
          { message: "Datas ISO inválidas." },
          { status: 400 },
        );
      }

      const currentPeriod: AnalyticsPeriod = { from, to };
      const previousPeriod: AnalyticsPeriod = { from: compFrom, to: compTo };

      const [current, previous] = await Promise.all([
        getDashboardMetrics(currentPeriod),
        getDashboardMetrics(previousPeriod),
      ]);

      return NextResponse.json({ current, previous });
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json(
        { message: "Erro ao carregar comparação de métricas." },
        { status: 500 },
      );
    }
  });
}
