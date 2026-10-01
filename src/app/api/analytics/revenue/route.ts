import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getRevenueOverTime, type AnalyticsPeriod } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/revenue");

function parseRequiredPeriod(
  searchParams: URLSearchParams
): AnalyticsPeriod | null {
  const fromS = searchParams.get("from");
  const toS = searchParams.get("to");
  if (!fromS || !toS) return null;
  const from = new Date(fromS);
  const to = new Date(toS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

function parseGroupBy(
  v: string | null
): "day" | "week" | "month" | null {
  if (v === "day" || v === "week" || v === "month") return v;
  return null;
}

// Bug 24/abr/26: usavamos `auth()` direto e o handler chamava
// `getRevenueOverTime` que depende de `getOrgIdOrThrow()` — sem o
// AsyncLocalStorage scope ativo, getOrgIdOrThrow() explodia. Trocamos
// por `withOrgContext` que envolve a lambda em runWithContext,
// garantindo que tudo dentro veja o tenant scope.
export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const period = parseRequiredPeriod(searchParams);
      if (!period) {
        return NextResponse.json(
          { message: "Parâmetros obrigatórios: from, to (ISO)." },
          { status: 400 }
        );
      }

      const groupBy = parseGroupBy(searchParams.get("groupBy"));
      if (!groupBy) {
        return NextResponse.json(
          { message: "groupBy deve ser day, week ou month." },
          { status: 400 }
        );
      }

      const data = await getRevenueOverTime(period, groupBy);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json(
        { message: "Erro ao carregar receita ao longo do tempo." },
        { status: 500 }
      );
    }
  });
}
