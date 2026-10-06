import { NextResponse } from "next/server";

import { isManagerOrAdmin, isSuperAdmin, withOrgContext } from "@/lib/auth-helpers";
import { computePainelRange, parseClockMode } from "@/services/painel-period";
import { getPainelTeam, parseTeamSections } from "@/services/painel-team";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/painel/team");

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IDS = 200;

function csv(value: string | null): string[] {
  return value
    ? value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_IDS)
    : [];
}

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    // Só gestores: mesma condição do ManagerHome no frontend (`isManagerUp` =
    // ADMIN, MANAGER ou super-admin). O painel do operador usa /api/painel/service.
    if (!isManagerOrAdmin(session) && !isSuperAdmin(session)) {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }
    try {
      const { searchParams } = new URL(request.url);
      const range = computePainelRange(
        searchParams.get("period"),
        searchParams.get("startDate"),
        searchParams.get("endDate"),
      );
      const data = await getPainelTeam(
        range,
        parseClockMode(searchParams.get("clock")),
        {
          departmentIds: csv(searchParams.get("departmentIds")),
          userIds: csv(searchParams.get("userIds")),
        },
        parseTeamSections(searchParams.get("section")),
      );
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "[api/painel/team] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar o painel da equipe." },
        { status: 500 },
      );
    }
  });
}
