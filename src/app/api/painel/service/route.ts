import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  getPainelService,
  parseServiceSections,
} from "@/services/painel-service";
import { computePainelRange, parseClockMode } from "@/services/painel-period";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";
import { timedJson } from "@/lib/server-timing-response";

const log = getLogger("api/painel/service");

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // `Server-Timing`: auth, q-<seção> (uma por seção que rodou; q-shared é a carga
  // compartilhada por tempo/atendentes/departamento/canais), serialize, total.
  // Seções rodam em paralelo: as fases se sobrepõem. Sem cache de servidor.
  const timing = new ServerTiming();
  return withOrgContext(async () => {
    timing.add("auth", timing.totalMs());
    try {
      const { searchParams } = new URL(request.url);
      const range = computePainelRange(
        searchParams.get("period"),
        searchParams.get("startDate"),
        searchParams.get("endDate"),
      );
      const clock = parseClockMode(searchParams.get("clock"));
      const data = await getPainelService(
        range,
        clock,
        parseServiceSections(searchParams.get("section")),
        timing,
      );
      return timedJson(timing, data);
    } catch (e) {
      log.error({ err: e }, "[api/painel/service] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar o painel de atendimentos." },
        { status: 500 },
      );
    }
  });
}
