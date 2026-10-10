import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { moveDealForUser } from "@/services/deal-move-flow";
import { getDealById } from "@/services/deals";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/deals/[id]/move");

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const userLike = session.user as {
        id: string;
        organizationId: string | null;
        role?: string | null;
        isSuperAdmin?: boolean;
      };
      const denied = await requirePermissionForUser(userLike, "deal:change_stage");
      if (denied) return denied;

      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const existing = await getDealById(id);
      if (!existing) {
        return NextResponse.json({ message: "Negócio não encontrado." }, { status: 404 });
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      if (!body || typeof body !== "object") {
        return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
      }

      const b = body as Record<string, unknown>;
      if (typeof b.stageId !== "string" || !b.stageId) {
        return NextResponse.json({ message: "stageId é obrigatório." }, { status: 400 });
      }
      // Motivo da perda — opcional, usado quando o destino é o estágio
      // Perdido (a tabulação é coletada no frontend antes do move).
      const lostReason = typeof b.lostReason === "string" ? b.lostReason.trim() : undefined;

      // Posse, escopo de etapa/funil, campos obrigatórios, motivo de perda,
      // gravação, cache/`deal_moved` e eventos: caminho único com o PUT.
      const moved = await moveDealForUser({
        actor: userLike,
        existing,
        stageId: b.stageId,
        position: b.position,
        lostReason,
      });
      if (!moved.ok) return moved.response;

      return NextResponse.json(moved.deal);
    } catch (e) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json({ message: "Erro ao mover negócio." }, { status: 500 });
    }
  });
}
