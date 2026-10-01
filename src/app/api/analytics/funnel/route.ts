import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getFunnelData } from "@/services/analytics";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/funnel");

// Bug 24/abr/26: usávamos `auth()` direto e o handler chamava
// `getFunnelData` que depende de `getOrgIdOrThrow()` — sem o
// AsyncLocalStorage scope ativo, getOrgIdOrThrow() explodia. Trocamos
// por `withOrgContext` que envolve a lambda em runWithContext,
// garantindo que tudo dentro veja o tenant scope.
export async function GET(request: Request) {
  return withOrgContext(async () => {
    try {
      const { searchParams } = new URL(request.url);
      const pipelineId = searchParams.get("pipelineId");
      if (!pipelineId?.trim()) {
        return NextResponse.json(
          { message: "pipelineId é obrigatório." },
          { status: 400 }
        );
      }

      const data = await getFunnelData(pipelineId);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json(
        { message: "Erro ao carregar dados do funil." },
        { status: 500 }
      );
    }
  });
}
