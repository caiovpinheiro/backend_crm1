import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getInboxMetrics } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/inbox");

// Bug 24/abr/26: usávamos `auth()` direto e o handler chamava
// `getInboxMetrics` que depende de `getOrgIdOrThrow()` — sem o
// AsyncLocalStorage scope ativo, getOrgIdOrThrow() explodia. Trocamos
// por `withOrgContext` que envolve a lambda em runWithContext,
// garantindo que tudo dentro veja o tenant scope (e já trata o 401).
export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const from = searchParams.get("from");
      const to = searchParams.get("to");

      const period =
        from && to
          ? { from: new Date(from), to: new Date(to) }
          : undefined;

      const data = await getInboxMetrics(period);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "[analytics/inbox] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar metricas de atendimento." },
        { status: 500 }
      );
    }
  });
}
