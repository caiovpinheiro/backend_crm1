import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { REPORT_MAX_RANGE_MS } from "@/lib/report-cache";
import { clampRangeFromEnd } from "@/services/painel-period";
import { getSystemUsageAggregate } from "@/services/system-presence";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/analytics/system-usage");

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/system-usage?from=ISO&to=ISO
 *
 * Agregação de "uso do CRM" (presença de USO, distinta do status da
 * Distribuição) por usuário da org, dentro da janela [from, to].
 *
 * Somente ADMIN/MANAGER (compartilha requireManager via withOrgContext +
 * checagem manual — mantemos leve para não duplicar helpers).
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const role = session.user.role;
    if (role !== "ADMIN" && role !== "MANAGER") {
      return NextResponse.json(
        { message: "Acesso restrito a administradores/gestores." },
        { status: 403 },
      );
    }
    const orgId = getOrgIdOrNull();
    if (!orgId) {
      // Super-admin sem org — nada a agregar.
      return NextResponse.json({ items: [] });
    }

    const { searchParams } = new URL(request.url);
    const fromS = searchParams.get("from");
    const toS = searchParams.get("to");
    if (!fromS || !toS) {
      return NextResponse.json(
        { message: "Parâmetros from e to são obrigatórios (ISO)." },
        { status: 400 },
      );
    }
    const requestedFrom = new Date(fromS);
    const to = new Date(toS);
    if (Number.isNaN(requestedFrom.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json(
        { message: "from/to devem ser datas ISO válidas." },
        { status: 400 },
      );
    }
    // Teto de 366 dias (igual a /api/logs/system-usage): mantém o fim e recua o início.
    const { from } = clampRangeFromEnd(
      { from: requestedFrom, to },
      REPORT_MAX_RANGE_MS,
    );
    const rangeClamped = from.getTime() !== requestedFrom.getTime();

    try {
      const items = await getSystemUsageAggregate({
        organizationId: orgId,
        from,
        to,
      });
      // Aditivo: só aparece quando o período foi cortado.
      return NextResponse.json(rangeClamped ? { items, rangeClamped: true } : { items });
    } catch (err) {
      // Migration pendente ou outro erro transiente — devolve vazio pra
      // não travar a tela de Analytics.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("system_usage_sessions")) {
        return NextResponse.json({ items: [], pending: true });
      }
      log.error({ err }, "[analytics/system-usage] erro");
      return NextResponse.json(
        { message: "Erro ao carregar uso do sistema." },
        { status: 500 },
      );
    }
  });
}
