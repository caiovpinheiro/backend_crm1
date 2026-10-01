import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getDashboardMe } from "@/services/dashboard-me";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/dashboard/me");

export const dynamic = "force-dynamic";

/** GET /api/dashboard/me — fila do operador (conversas, tarefas, parados). */
export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const data = await getDashboardMe(session.user.id);
      return NextResponse.json(data);
    } catch (e) {
      log.error({ err: e }, "[dashboard/me] falhou");
      return NextResponse.json(
        { message: "Erro ao carregar sua fila." },
        { status: 500 },
      );
    }
  });
}
