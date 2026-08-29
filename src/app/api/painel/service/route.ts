import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  getPainelService,
  parseServiceSections,
} from "@/services/painel-service";
import { computePainelRange, parseClockMode } from "@/services/painel-period";

export async function GET(request: Request) {
  return withOrgContext(async () => {
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
      );
      return NextResponse.json(data);
    } catch (e) {
      console.error("[api/painel/service]", e);
      return NextResponse.json(
        { message: "Erro ao carregar o painel de atendimentos." },
        { status: 500 },
      );
    }
  });
}
