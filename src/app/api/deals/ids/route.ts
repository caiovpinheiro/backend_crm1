import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import type { AppUserRole } from "@/lib/auth-types";
import {
  requirePermissionForUser,
  requirePipelineScope,
} from "@/lib/authz/resource-policy";
import { getVisibilityFilter } from "@/lib/visibility";
import { isValidDealStatus, resolveBoardDealIds } from "@/services/deals";
import { parseAdvancedDealFilters } from "@/services/kanban-filters";

const MAX_IDS = 5000;

/**
 * POST /api/deals/ids
 *
 * Devolve só os IDs que batem no recorte do board (funil + etapa +
 * filtros + visibilidade). Usado pelo checkbox do header da coluna no
 * kanban: "selecionar todos desta etapa" precisa dos IDs além dos
 * cards já carregados (página de 10/200).
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const denied = await requirePermissionForUser(session.user, "deal:view");
      if (denied) return denied;

      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const pipelineId =
        typeof body?.pipelineId === "string" ? body.pipelineId.trim() : "";
      if (!pipelineId) {
        return NextResponse.json(
          { message: "pipelineId é obrigatório." },
          { status: 400 },
        );
      }

      const scopeDenied = await requirePipelineScope(
        session.user,
        "view",
        pipelineId,
      );
      if (scopeDenied) return scopeDenied;

      const stageId =
        typeof body?.stageId === "string" && body.stageId.trim()
          ? body.stageId.trim()
          : undefined;
      const statusRaw = typeof body?.status === "string" ? body.status : undefined;
      const statusFilter =
        statusRaw === "ALL"
          ? ("ALL" as const)
          : statusRaw && isValidDealStatus(statusRaw)
            ? statusRaw
            : undefined;

      const visibility = await getVisibilityFilter(
        session.user as { id: string; role: AppUserRole },
      );

      const resolved = await resolveBoardDealIds(pipelineId, {
        visibilityOwnerId: visibility.canSeeAll ? null : session.user.id,
        statusFilter,
        filters: parseAdvancedDealFilters(body?.filters),
        stageId,
        cap: MAX_IDS,
      });

      return NextResponse.json({
        ids: resolved.ids,
        total: resolved.ids.length,
        capped: resolved.capped,
      });
    } catch (e) {
      console.error(e);
      return NextResponse.json(
        { message: "Erro ao resolver negócios." },
        { status: 500 },
      );
    }
  });
}
