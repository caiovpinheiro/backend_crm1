import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  requirePermissionForUser,
  requirePipelineScope,
  requireStageScope,
} from "@/lib/authz/resource-policy";
import { getLogger } from "@/lib/logger";
import { fireTrigger } from "@/services/automation-triggers";
import { createDealEvent, duplicateDeal, getDealById } from "@/services/deals";

const log = getLogger("api/deals/[id]/duplicate");

type RouteContext = { params: Promise<{ id: string }> };

const DUPLICATE_ERRORS: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "Negócio não encontrado." },
  PIPELINE_NOT_FOUND: { status: 404, message: "Funil não encontrado." },
  STAGE_NOT_FOUND: { status: 404, message: "Etapa não encontrada." },
  STAGE_PIPELINE_MISMATCH: { status: 400, message: "A etapa não pertence ao funil escolhido." },
  TERMINAL_STAGE: { status: 400, message: "Escolha uma etapa que não seja Ganho nem Perdido." },
};

export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const user = session.user as {
        id: string;
        organizationId: string | null;
        role?: string | null;
        isSuperAdmin?: boolean;
      };
      const viewDenied = await requirePermissionForUser(user, "deal:view");
      if (viewDenied) return viewDenied;
      const createDenied = await requirePermissionForUser(user, "deal:create");
      if (createDenied) return createDenied;

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
      const b = body as Record<string, unknown>;
      if (typeof b.pipelineId !== "string" || !b.pipelineId) {
        return NextResponse.json({ message: "pipelineId é obrigatório." }, { status: 400 });
      }
      if (typeof b.stageId !== "string" || !b.stageId) {
        return NextResponse.json({ message: "stageId é obrigatório." }, { status: 400 });
      }

      const pipelineDenied = await requirePipelineScope(user, "view", b.pipelineId);
      if (pipelineDenied) return pipelineDenied;
      const stageDenied = await requireStageScope(user, "move", b.stageId);
      if (stageDenied) return stageDenied;

      const deal = await duplicateDeal(existing.id, {
        pipelineId: b.pipelineId,
        stageId: b.stageId,
      });
      createDealEvent(deal.id, user.id, "CREATED", {
        stageId: b.stageId,
        duplicatedFromDealId: existing.id,
        intentionalDuplicate: true,
      }).catch(() => {});
      fireTrigger("deal_created", {
        dealId: deal.id,
        contactId: deal.contactId ?? undefined,
        data: { stageId: b.stageId, toStageId: b.stageId, pipelineId: b.pipelineId },
      }).catch(() => {});
      return NextResponse.json(deal, { status: 201 });
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : "";
      const mapped = DUPLICATE_ERRORS[code];
      if (mapped) {
        return NextResponse.json({ message: mapped.message }, { status: mapped.status });
      }
      log.error({ err }, "POST duplicate falhou");
      return NextResponse.json({ message: "Erro ao duplicar negócio." }, { status: 500 });
    }
  });
}
