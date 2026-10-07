/**
 * Mover negócio de etapa a pedido de um usuário — caminho ÚNICO.
 *
 * `POST /api/deals/:id/move` e `PUT /api/deals/:id` com `stageId` passam por
 * aqui. Antes o PUT atualizava a etapa direto (`updateDeal`): pulava os
 * campos obrigatórios da etapa (`STAGE_FIELDS_REQUIRED`), o motivo de perda,
 * os eventos/triggers de Ganho/Perdido e o `deal_moved` do board; e nenhuma
 * das duas rotas conferia de quem era o negócio.
 *
 * Ordem das checagens: posse do negócio (403) → permissão de mover para a
 * etapa destino → acesso ao funil destino → `position` → `moveDeal` (campos
 * obrigatórios, motivo de perda, gravação, cache do board e `deal_moved`) →
 * eventos e triggers da timeline.
 *
 * Devolve `{ ok: false, response }` com a resposta HTTP pronta para as
 * recusas esperadas; erro inesperado é relançado.
 */
import { NextResponse } from "next/server";

import type { AppUserRole } from "@/lib/auth-types";
import { requirePipelineScope, requireStageScope } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { canSeeDealByOwner, getVisibilityFilter } from "@/lib/visibility";
import { fireTrigger } from "@/services/automation-triggers";
import {
  createDealEvent,
  getDealById,
  moveDeal,
  StageFieldsRequiredError,
} from "@/services/deals";

export type MoveDealActor = {
  id: string;
  organizationId: string | null;
  role?: string | null;
  isSuperAdmin?: boolean;
};

export type MoveDealExisting = NonNullable<Awaited<ReturnType<typeof getDealById>>>;

export type MoveDealFlowResult =
  | { ok: true; deal: NonNullable<Awaited<ReturnType<typeof moveDeal>>> }
  | { ok: false; response: NextResponse };

function fail(message: string, status: number, extra?: Record<string, unknown>): MoveDealFlowResult {
  return { ok: false, response: NextResponse.json({ message, ...extra }, { status }) };
}

export async function moveDealForUser(args: {
  actor: MoveDealActor;
  /** Negócio já lido (`getDealById`), antes da troca. */
  existing: MoveDealExisting;
  stageId: string;
  /** Índice na coluna destino; validado aqui (inteiro >= 0). */
  position: unknown;
  lostReason?: string;
}): Promise<MoveDealFlowResult> {
  const { actor, existing, stageId, lostReason } = args;
  const dealId = existing.id;

  // Mesma regra do GET /api/deals/:id: quem não vê o negócio não o move.
  const visibility = await getVisibilityFilter({
    id: actor.id,
    role: actor.role as AppUserRole,
  });
  if (!canSeeDealByOwner(visibility, actor.id, existing.ownerId ?? null)) {
    return fail("Acesso negado.", 403);
  }

  const stageDenied = await requireStageScope(actor, "move", stageId);
  if (stageDenied) return { ok: false, response: stageDenied };

  // Troca de funil: exige acesso ao funil de destino também (o
  // requireStageScope cobre a etapa, a política de funil é uma camada extra).
  const targetStageMeta = await prisma.stage.findUnique({
    where: { id: stageId },
    select: { pipelineId: true },
  });
  if (!targetStageMeta) return fail("Estágio não encontrado.", 400);
  const fromPipelineId = existing.stage.pipeline?.id ?? null;
  const toPipelineId = targetStageMeta.pipelineId;
  if (fromPipelineId && toPipelineId !== fromPipelineId) {
    const pipeDenied = await requirePipelineScope(actor, "view", toPipelineId);
    if (pipeDenied) return { ok: false, response: pipeDenied };
  }

  const position = args.position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
    return fail("position inválido.", 400);
  }

  let deal: Awaited<ReturnType<typeof moveDeal>>;
  try {
    deal = await moveDeal(dealId, stageId, position, { lostReason });
  } catch (err: unknown) {
    if (err instanceof StageFieldsRequiredError) {
      return fail(err.message, 400, { code: "STAGE_FIELDS_REQUIRED", fields: err.fields });
    }
    if (err instanceof Error) {
      if (err.message === "NOT_FOUND") return fail("Negócio não encontrado.", 404);
      if (err.message === "STAGE_NOT_FOUND") return fail("Estágio não encontrado.", 400);
      if (err.message === "INVALID_POSITION") return fail("position inválido.", 400);
      if (err.message === "LOST_REASON_REQUIRED") {
        return fail("Motivo da perda é obrigatório neste funil.", 400);
      }
      if (err.message === "INVALID_LOST_REASON") {
        return fail(
          "Motivo da perda inválido. Selecione um dos motivos cadastrados em Configurações → Motivos de perda.",
          400,
        );
      }
    }
    throw err;
  }
  if (!deal) return fail("Negócio não encontrado.", 404);

  if (stageId !== existing.stage.id) {
    const uid = actor.id;
    const toStage = (deal as {
      stage?: { id: string; name: string; pipeline?: { id: string; name: string } | null };
    }).stage;
    const pipelineChanged = fromPipelineId && toPipelineId !== fromPipelineId;
    const fromStage = {
      id: existing.stage.id,
      name: existing.stage.name,
      pipelineId: fromPipelineId,
      pipelineName: existing.stage.pipeline?.name ?? null,
    };
    createDealEvent(dealId, uid, "STAGE_CHANGED", {
      from: fromStage,
      to: {
        id: stageId,
        name: toStage?.name ?? stageId,
        pipelineId: toStage?.pipeline?.id ?? toPipelineId,
        pipelineName: toStage?.pipeline?.name ?? null,
      },
      ...(pipelineChanged ? { pipelineChanged: true } : {}),
    }).catch(() => {});

    fireTrigger("stage_changed", {
      dealId,
      contactId: existing.contactId ?? undefined,
      data: {
        fromStageId: fromStage.id,
        toStageId: stageId,
        fromPipelineId,
        toPipelineId,
      },
    }).catch(() => {});

    // Estágios terminais (Ganho/Perdido): o moveDeal sincroniza Deal.status —
    // aqui replicamos os side effects do fluxo de status (evento + trigger)
    // pra manter paridade com PUT /status.
    const fromStatus = existing.status;
    const newStatus = (deal as { status?: string }).status;
    if (newStatus && newStatus !== fromStatus) {
      createDealEvent(dealId, uid, "STATUS_CHANGED", {
        from: fromStatus,
        to: newStatus,
        ...(newStatus === "LOST" && lostReason ? { lostReason } : {}),
      }).catch(() => {});
      if (newStatus === "WON") {
        fireTrigger("deal_won", {
          dealId,
          contactId: existing.contactId ?? undefined,
          data: { fromStatus },
        }).catch(() => {});
      } else if (newStatus === "LOST") {
        fireTrigger("deal_lost", {
          dealId,
          contactId: existing.contactId ?? undefined,
          data: { fromStatus, lostReason },
        }).catch(() => {});
      }
    }
  }

  return { ok: true, deal };
}
